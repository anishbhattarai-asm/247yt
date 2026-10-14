# Stream Panel on one Always Free Arm server, set up with no SSH:
#
#   network (VCN, internet gateway, public subnet, firewall rules)
#   -> Ubuntu 24.04 VM.Standard.A1.Flex
#   -> cloud-init runs deploy/setup.sh --unattended at first boot
#
# The panel is then reached at http://<public ip>:8080 (the stable link,
# which forwards to the panel's Cloudflare link) and the first visitor needs
# the setup code from this stack's outputs to choose the password.

terraform {
  required_version = ">= 1.2"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 5.0.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.4.0"
    }
  }
}

provider "oci" {
  region = var.region
}

data "oci_identity_availability_domains" "all" {
  compartment_id = var.tenancy_ocid
}

# The newest Canonical Ubuntu 24.04 build for Arm (A1) servers.
data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

locals {
  ad          = var.availability_domain != "" ? var.availability_domain : data.oci_identity_availability_domains.all.availability_domains[0].name
  finder_port = 8080
  obs_port    = 9710
  code        = random_string.setup_code.result
  setup_code  = "${substr(local.code, 0, 5)}-${substr(local.code, 5, 5)}"
}

# One-time code for choosing the panel password in the browser. It stops
# working as soon as the password is set.
resource "random_string" "setup_code" {
  length  = 10
  upper   = true
  lower   = false
  numeric = true
  special = false
}

# network

resource "oci_core_vcn" "panel" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = ["10.0.0.0/16"]
  display_name   = "stream-panel"
  dns_label      = "streampanel"
}

resource "oci_core_internet_gateway" "panel" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.panel.id
  display_name   = "stream-panel"
  enabled        = true
}

resource "oci_core_route_table" "panel" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.panel.id
  display_name   = "stream-panel"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.panel.id
  }
}

resource "oci_core_security_list" "panel" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.panel.id
  display_name   = "stream-panel"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  # SSH (only works with a key; Oracle's images have password logins off)
  ingress_security_rules {
    source   = "0.0.0.0/0"
    protocol = "6"
    tcp_options {
      min = 22
      max = 22
    }
  }

  # Stable link: only forwards to the panel's current Cloudflare link
  ingress_security_rules {
    source   = "0.0.0.0/0"
    protocol = "6"
    tcp_options {
      min = local.finder_port
      max = local.finder_port
    }
  }

  # OBS live input (SRT over UDP); nothing listens until it is switched on
  ingress_security_rules {
    source   = "0.0.0.0/0"
    protocol = "17"
    udp_options {
      min = local.obs_port
      max = local.obs_port
    }
  }

  # Path MTU discovery
  ingress_security_rules {
    source   = "0.0.0.0/0"
    protocol = "1"
    icmp_options {
      type = 3
      code = 4
    }
  }

  ingress_security_rules {
    source   = "10.0.0.0/16"
    protocol = "1"
    icmp_options {
      type = 3
    }
  }
}

resource "oci_core_subnet" "panel" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.panel.id
  cidr_block                 = "10.0.0.0/24"
  display_name               = "stream-panel"
  dns_label                  = "public"
  route_table_id             = oci_core_route_table.panel.id
  security_list_ids          = [oci_core_security_list.panel.id]
  prohibit_public_ip_on_vnic = false
}

# server

resource "oci_core_instance" "panel" {
  availability_domain = local.ad
  compartment_id      = var.compartment_ocid
  display_name        = "stream-panel"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_gbs
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gbs
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.panel.id
    assign_public_ip = true
    display_name     = "stream-panel"
    hostname_label   = "streampanel"
  }

  metadata = merge(
    {
      user_data = base64encode(templatefile("${path.module}/cloud-init.yaml", {
        repo_url    = var.repo_url
        branch      = var.branch
        setup_code  = local.setup_code
        finder_port = local.finder_port
      }))
    },
    var.ssh_public_key != "" ? { ssh_authorized_keys = var.ssh_public_key } : {},
  )

  # A later Apply must never rebuild the server (and delete its videos): a
  # newer Ubuntu image, an edited install script, another availability domain
  # or disk size on the form are ignored once it exists. SSH keys also only
  # count at creation (Oracle applies them at first boot). OCPUs and memory
  # can still change: Oracle resizes the server in place.
  lifecycle {
    ignore_changes = [metadata, availability_domain, source_details]
  }
}
