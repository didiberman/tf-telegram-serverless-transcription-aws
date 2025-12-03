output "s3_bucket_name" {
  value       = aws_s3_bucket.transcribe_bucket.id
  description = "The name of the S3 bucket"
}

output "s3_bucket_arn" {
  value       = aws_s3_bucket.transcribe_bucket.arn
  description = "The ARN of the S3 bucket"
}

output "s3_bucket_domain_name" {
  value       = aws_s3_bucket.transcribe_bucket.bucket_regional_domain_name
  description = "The regional domain name of the S3 bucket"
}

output "webhook_url" {
  value       = aws_lambda_function_url.webhook_url.function_url
  description = "The URL for the Telegram Webhook"
}
