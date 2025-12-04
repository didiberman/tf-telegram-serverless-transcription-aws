variable "telegram_bot_token" {
  description = "The Telegram Bot Token"
  type        = string
  sensitive   = true
}

variable "bucket_name" {
  description = "The unique name for the S3 bucket"
  type        = string
}

variable "telegram_admin_username" {
  description = "The Telegram username of the admin (without @)"
  type        = string
}
