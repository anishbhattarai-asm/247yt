# Filled in by Oracle Resource Manager (the Deploy button) on its own.
variable "tenancy_ocid" {
  type = string
}

variable "compartment_ocid" {
  type = string
}

variable "region" {
  type = string
}

# Shown on the stack's form (see schema.yaml).
variable "availability_domain" {
  description = "Where the server goes. Empty = the region's first one."
  type        = string
  default     = ""
}

variable "ssh_public_key" {
  description = "Optional: lets you log in to the server's command line."
  type        = string
  default     = ""
}

# The defaults fit Oracle's Always Free allowance (4 OCPUs, 24 GB memory and
# 200 GB of disk in total across all your servers).
variable "ocpus" {
  type    = number
  default = 2
}

variable "memory_gbs" {
  type    = number
  default = 12
}

variable "boot_volume_gbs" {
  type    = number
  default = 200
}

# Where the server downloads Stream Panel from (hidden on the form).
variable "repo_url" {
  type    = string
  default = "https://github.com/anishbhattarai-asm/247yt.git"
}

variable "branch" {
  type    = string
  default = "main"
}
