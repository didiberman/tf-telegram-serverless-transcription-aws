variable "telegram_bot_token" {
  description = "The Telegram Bot Token"
  type        = string
  sensitive   = true
}

variable "bucket_name" {
  description = "The unique name for the S3 bucket"
  type        = string
}

variable "allowed_usernames" {
  description = "Comma-separated list of allowed Telegram usernames (e.g. 'user1,user2')"
  type        = string
  default     = ""
}
