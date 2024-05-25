
# TianGong-LCA-Edge-Functions

## Env Preparing

```bash

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
npm i supabase --save-dev
npx supabase start

```

## Supabase Config

```bash
npx supabase login
npx supabase functions new hello
npx supabase functions deploy hello --project-ref qgzvkongdjqiiamzbbts
```
## local

USE VSCode Debug to start Server -> Launch Supabase Function


## Remote

```bash
curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/embedding' \
  --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
  --header 'Content-Type: application/json' \
  --data '{"query":["Hello", "World"]}'
```
