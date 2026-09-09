/**
 * Centralized AWS SDK Configuration
 * This file contains all AWS service clients used across the application
 * Import from this file instead of initializing clients in individual functions
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
  QueryCommand,
  BatchWriteCommand,
  BatchGetCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  S3Client,
  PutObjectCommand,
  UploadPartCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  PutBucketWebsiteCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const {
  SESClient,
  SendEmailCommand,
  SendRawEmailCommand,
} = require("@aws-sdk/client-ses");
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminUpdateUserAttributesCommand,
  ListUsersCommand,
  SignUpCommand,
  AdminConfirmSignUpCommand,
  AdminSetUserPasswordCommand,
  InitiateAuthCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const {
  CognitoIdentityClient,
  GetIdCommand,
} = require("@aws-sdk/client-cognito-identity");
const {
  CloudFrontClient,
  CreateInvalidationCommand,
  GetDistributionCommand,
  ListDistributionsCommand,
  CreateDistributionCommand,
  UpdateDistributionCommand,
} = require("@aws-sdk/client-cloudfront");
const {
  ACMClient,
  RequestCertificateCommand,
  DescribeCertificateCommand
} = require("@aws-sdk/client-acm");
const { Route53Client,
  ListHostedZonesCommand,
  ChangeResourceRecordSetsCommand,
  GetHostedZoneCommand,
  CreateHostedZoneCommand,
  ListResourceRecordSetsCommand,
ListHostedZonesByNameCommand, } = require("@aws-sdk/client-route-53");
// AWS SDK v3 does not expose DocumentClient.createSet.
// Keep this helper for backward compatibility with existing handlers.
function createSet(values) {
  if (values instanceof Set) {
    return values;
  }
  if (Array.isArray(values)) {
    return new Set(values);
  }
  return new Set([values]);
}

// AWS Region Configuration
const AWS_REGION = process.env.AWS_REGION || "us-east-2";
// Data plane (DynamoDB / Cognito) may live in a different region than the Lambda.
const DATA_AWS_REGION = process.env.DATA_AWS_REGION || AWS_REGION;
const COGNITO_REGION = process.env.COGNITO_REGION || DATA_AWS_REGION;
const TASKS_AWS_REGION = process.env.TASKS_AWS_REGION || "ap-south-1";

const documentClientOptions = {
  marshallOptions: {
    removeUndefinedValues: true,
    convertEmptyValues: false,
  },
  unmarshallOptions: {
    wrapNumbers: false,
  },
};

// DynamoDB Client Configuration
const dynamoDbClient = new DynamoDBClient({ region: DATA_AWS_REGION });
const dynamoDB = DynamoDBDocumentClient.from(dynamoDbClient, documentClientOptions);

// Employee DynamoDB Client Configuration (for ap-south-1 region)
const employeeDynamoDbClient = new DynamoDBClient({ region: TASKS_AWS_REGION });
const employeeDynamo = DynamoDBDocumentClient.from(
  employeeDynamoDbClient,
  documentClientOptions,
);

// Tasks table lives in a separate region from the default AWS_REGION.
const tasksDynamoDbClient = new DynamoDBClient({ region: TASKS_AWS_REGION });
const tasksDynamoDB = DynamoDBDocumentClient.from(
  tasksDynamoDbClient,
  documentClientOptions,
);

// S3 Client Configuration
const s3Client = new S3Client({ region: AWS_REGION });

// SES Client Configuration
const sesClient = new SESClient({ region: AWS_REGION });

// SNS Client Configuration
const snsClient = new SNSClient({ region: AWS_REGION });
// Route53 Client Configuration
const route53 = new Route53Client({ region: AWS_REGION });

const acm = new ACMClient({ region: "us-east-1" });

// Cognito Identity Provider Client Configuration
const cognitoIdentityProvider = new CognitoIdentityProviderClient({
  region: COGNITO_REGION,
});

// Cognito Identity Client Configuration
const cognitoIdentity = new CognitoIdentityClient({ region: COGNITO_REGION });

// CloudFront Client Configuration (AWS SDK v3)
const cloudfront = new CloudFrontClient({ region: "us-east-1" });

// Helper function to create regional S3 client for multipart uploads
function getS3ClientForRegion(region = AWS_REGION) {
  return new S3Client({ region: region });
}

// Helper function to get presigned URL for S3 operations
async function getS3PresignedUrl(
  bucket,
  key,
  operation = "uploadPart",
  params = {},
  region = AWS_REGION
) {
  const client = new S3Client({ region: region });
  const commandParams = { Bucket: bucket, Key: key, ...params };

  let command;
  if (operation === "uploadPart") {
    command = new UploadPartCommand(commandParams);
  } else {
    command = new PutObjectCommand(commandParams);
  }

  return await getSignedUrl(client, command, { expiresIn: 3600 });
}

// Export all clients and commands
module.exports = {
  // DynamoDB
  dynamoDB,
  employeeDynamo,
  dynamoDbClient,
  tasksDynamoDB,
  tasksDynamoDbClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
  QueryCommand,
  BatchWriteCommand,
  BatchGetCommand,

  // S3
  s3Client,
  S3Client,
  PutObjectCommand,
  UploadPartCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  PutBucketWebsiteCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
  getSignedUrl,
  getS3ClientForRegion,
  getS3PresignedUrl,

  // SES
  sesClient,
  route53,
  acm,
  ListHostedZonesCommand,
  ChangeResourceRecordSetsCommand,
  ListResourceRecordSetsCommand,
  CreateHostedZoneCommand,
  GetHostedZoneCommand,
  RequestCertificateCommand,
  ListHostedZonesByNameCommand,
  DescribeCertificateCommand,
  SendEmailCommand,
  SendRawEmailCommand,

  // SNS
  snsClient,
  PublishCommand,

  // Cognito Identity Provider
  cognitoIdentityProvider,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminUpdateUserAttributesCommand,
  ListUsersCommand,
  SignUpCommand,
  AdminConfirmSignUpCommand,
  AdminSetUserPasswordCommand,
  InitiateAuthCommand,

  // Cognito Identity
  cognitoIdentity,
  GetIdCommand,

  // CloudFront
  cloudfront,
  CloudFrontClient,
  CreateInvalidationCommand,
  GetDistributionCommand,
  ListDistributionsCommand,
  CreateDistributionCommand,
  UpdateDistributionCommand,

  // Utilities
  createSet,

  // Configuration
  AWS_REGION,
  TASKS_AWS_REGION,
};

// Deprecated: Use cognitoIdentityProvider instead
const cognitoClient = cognitoIdentityProvider;
module.exports.cognitoClient = cognitoClient;
