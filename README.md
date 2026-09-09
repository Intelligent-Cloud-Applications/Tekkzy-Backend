# Tekkzy Backend

Standalone Serverless (AWS Lambda + API Gateway) service for Tekkzy product APIs.

Previously these handlers lived inside `awsaiapp-backend` under `beta_functions/tekkzy/`.
This repo is the dedicated home going forward.

## Stack

- Node.js 20
- Serverless Framework v3
- DynamoDB / S3 / Route53 / ACM / CloudFront
- Razorpay (domain deploy subscriptions)

## Setup

```bash
cd tekkzy-backend
cp .env.example .env
# Fill .env (or copy Tekkzy-related keys from awsaiapp-backend .env)
yarn install
```

## Deploy

```bash
yarn deploy
# → serverless deploy --stage dev
```

After deploy, copy the **ApiGateway URL** into the Tekkzy frontend:

```env
# Tekkzy/.env
VITE_API_ENDPOINT=https://xxxx.execute-api.us-east-2.amazonaws.com/dev
```

## Local tests

```bash
yarn test
```

## Main route groups

| Area | Paths |
|------|--------|
| Profile | `/get-profile`, `/create-profile`, `/update-profile` |
| Templates | `/list-templates`, `/tekkzy/upload-template`, … |
| Sites | `/create-site`, `/list-user-sites`, `/get-site`, `/deploy-site` |
| Domain DNS | `/check-subdomain-availability`, `/start-domain-setup`, … |
| Legacy pay | `/create-payment-session`, `/create-razorpay-order`, … |
| Domain pay (new) | `/tekkzy/domain/pricing`, `/checkout/create`, `/verify`, `/status`, webhook |
| Contact (public) | `POST /tekkzy/contact` — SES email; pass `_meta.toEmail` from site `data.json` |

## Relation to awsaiapp-backend

- Shares the same Cognito pool and DynamoDB tables (by env config).
- Do **not** deploy the same function names from both stacks to avoid confusion;
  point the frontend at **this** API once `tekkzy-backend` is deployed.
- You can leave Tekkzy routes in awsaiapp-backend temporarily for rollback,
  then remove them after cutover.
