# TianGong-LCA-Edge-Functions

## Env Preparing (Docker Engine MUST be Running)

```bash

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 22
nvm use

curl -fsSL https://deno.land/install.sh | sh -s v2.1.4

# Install dependencies (first run)
npm install

# Run npm update && npm ci to update dependencies again after executing deno cache in VSCode.
npm update && npm ci

npm start

```

Rename the `.env.example` to `.env.local` and fill in the the values before the `npx supabase start` command.

## Local Development

````bash

Started supabase local development setup.

```bash
         API URL: http://127.0.0.1:54321
     GraphQL URL: http://127.0.0.1:54321/graphql/v1
  S3 Storage URL: http://127.0.0.1:54321/storage/v1/s3
          DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres
      Studio URL: http://127.0.0.1:54323
    Inbucket URL: http://127.0.0.1:54324
      JWT secret: super-secret-jwt-token-with-at-least-32-characters-long
service_role key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU
   S3 Access Key: 625729a08b95bf1b7ff351a663f3a23c
   S3 Secret Key: 850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907
       S3 Region: local
````

## Local Test

```bash

npm start
npx supabase functions serve --env-file ./supabase/.env.local

curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/embedding' \
  --header 'Content-Type: application/json' \
  --data '{"query":["Hello", "World"]}'
```

## Remote Config

```bash
npx supabase login

npx supabase secrets set --env-file ./supabase/.env.local --project-ref qgzvkongdjqiiamzbbts


npx supabase functions deploy flow_hybrid_search --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy process_hybrid_search --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt

npx supabase functions deploy embedding --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy webhook_flow_embedding --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy webhook_process_embedding --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt

npx supabase functions deploy request_process_data --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy sign_request --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy run_antchain_calculation --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy get_local_ip --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy create_calculation --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy query_calculation_status --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy query_calculation_results --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt

npx supabase functions deploy update_data --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt

npx supabase functions deploy sign_up_cognito --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy change_password_cognito --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
npx supabase functions deploy change_email_cognito --project-ref qgzvkongdjqiiamzbbts --no-verify-jwt
```
