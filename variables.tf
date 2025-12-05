variable "telegram_bot_token" {
  description = "The Telegram Bot Token"
  type        = string
  sensitive   = true
}

variable "telegram_admin_username" {
  description = "The Telegram Username of the Admin (without @)"
  type        = string
}

variable "bucket_name" {
  description = "The name of the S3 bucket (must be globally unique)"
  type        = string
}

variable "aws_region" {
  description = "AWS Region"
  type        = string
  default     = "us-east-1"
}
