# TianGong-LCA-Edge-Functions

## Env Preparing (Docker Engine MUST be Running)

```bash

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
nvm use

curl -fsSL https://deno.land/install.sh | sh -s v1.45.2

# Update packages
npm update && npm ci

npx supabase start

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
        anon key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
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
  --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
  --header 'Content-Type: application/json' \
  --data '{"query":["Hello", "World"]}'
```

## Remote Config

```bash
npx supabase login

npx supabase functions new hello

npx supabase functions deploy flow_hybrid_search --project-ref qgzvkongdjqiiamzbbts
npx supabase functions deploy process_hybrid_search --project-ref qgzvkongdjqiiamzbbts

npx supabase functions deploy embed --project-ref qgzvkongdjqiiamzbbts
npx supabase functions deploy flow_embedding --project-ref qgzvkongdjqiiamzbbts
npx supabase functions deploy webhook_flow_embedding --project-ref qgzvkongdjqiiamzbbts

npx supabase functions deploy process_embedding --project-ref qgzvkongdjqiiamzbbts
npx supabase functions deploy webhook_process_embedding --project-ref qgzvkongdjqiiamzbbts

npx supabase secrets set --env-file ./supabase/.env.local --project-ref qgzvkongdjqiiamzbbts
```
