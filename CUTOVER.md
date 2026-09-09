# Cutover: awsaiapp-backend → tekkzy-backend

## Created

Path: `F:\Internship\tekkzy\tekkzy-backend`

Contains all Tekkzy handlers previously under `awsaiapp-backend/beta_functions/tekkzy/`,
plus shared `Utils/`, a focused `serverless.yml`, and domain-payment APIs.

## Deploy tekkzy-backend

```bash
cd F:\Internship\tekkzy\tekkzy-backend
yarn install
yarn deploy
```

Save the printed API endpoint, e.g.
`https://abcdef123.execute-api.us-east-2.amazonaws.com/dev`

## Point Tekkzy frontend at it

In `Tekkzy/.env`:

```
VITE_API_ENDPOINT=https://abcdef123.execute-api.us-east-2.amazonaws.com/dev
```

Restart `npm run dev`.

Frontend already reads `VITE_API_ENDPOINT` in `src/config/amplifyConfig.js`
(falls back to the old awsaiapp API until you set the new URL).

## After successful cutover

Optionally remove Tekkzy functions from `awsaiapp-backend/serverless.yml`
so you do not maintain two copies. Keep awsaiapp-backend for non-Tekkzy products.
