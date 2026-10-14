output "panel_link" {
  description = "Opens the panel (forwards to its current Cloudflare link)"
  value       = "http://${oci_core_instance.panel.public_ip}:${local.finder_port}"
}

output "setup_code" {
  description = "Enter it on the panel's first visit to choose the password"
  value       = local.setup_code
}

output "public_ip" {
  value = oci_core_instance.panel.public_ip
}

output "ssh" {
  value = var.ssh_public_key != "" ? "ssh ubuntu@${oci_core_instance.panel.public_ip}" : "No SSH key was given (the panel does everything)"
}
