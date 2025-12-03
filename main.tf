resource "aws_s3_bucket" "transcribe_bucket" {
  bucket = var.bucket_name
}

# --- IAM for Lambda ---

resource "aws_iam_role" "lambda_role" {
  name = "transcribe_bot_lambda_role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "lambda_policy" {
  name = "transcribe_bot_lambda_policy"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.transcribe_bucket.arn,
          "${aws_s3_bucket.transcribe_bucket.arn}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "transcribe:StartTranscriptionJob",
          "transcribe:GetTranscriptionJob",
          "transcribe:ListTranscriptionJobs"
        ]
        Resource = "*"
      }
    ]
  })
}

# --- Lambda Functions ---

# Archive the code
data "archive_file" "webhook_zip" {
  type        = "zip"
  source_dir  = "${path.module}/src/webhook"
  output_path = "${path.module}/webhook.zip"
}

data "archive_file" "processor_zip" {
  type        = "zip"
  source_dir  = "${path.module}/src/processor"
  output_path = "${path.module}/processor.zip"
}

# Webhook Lambda
resource "aws_lambda_function" "webhook" {
  filename         = data.archive_file.webhook_zip.output_path
  function_name    = "transcribe_bot_webhook"
  role             = aws_iam_role.lambda_role.arn
  handler          = "index.handler"
  source_code_hash = data.archive_file.webhook_zip.output_base64sha256
  runtime          = "nodejs18.x"
  timeout          = 30

  environment {
    variables = {
      TELEGRAM_TOKEN    = var.telegram_bot_token
      BUCKET_NAME       = aws_s3_bucket.transcribe_bucket.id
      ALLOWED_USERNAMES = var.allowed_usernames
    }
  }
}

# Function URL for Webhook
resource "aws_lambda_function_url" "webhook_url" {
  function_name      = aws_lambda_function.webhook.function_name
  authorization_type = "NONE"
}

# Processor Lambda
resource "aws_lambda_function" "processor" {
  filename         = data.archive_file.processor_zip.output_path
  function_name    = "transcribe_bot_processor"
  role             = aws_iam_role.lambda_role.arn
  handler          = "index.handler"
  source_code_hash = data.archive_file.processor_zip.output_base64sha256
  runtime          = "nodejs22.x"
  timeout          = 30

  environment {
    variables = {
      TELEGRAM_TOKEN = var.telegram_bot_token
    }
  }
}

# S3 Trigger for Processor
resource "aws_lambda_permission" "allow_s3" {
  statement_id  = "AllowExecutionFromS3"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.processor.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.transcribe_bucket.arn
}

resource "aws_s3_bucket_notification" "bucket_notification" {
  bucket = aws_s3_bucket.transcribe_bucket.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.processor.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "output/"
    filter_suffix       = ".json"
  }

  depends_on = [aws_lambda_permission.allow_s3]
}

