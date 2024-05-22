
# TianGong-LCA-Edge-Functions

## Env Preparing

```bash

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
npm i supabase --save-dev
```

## Supabase Config

```bash
npx supabase login
npx supabase functions new hello
npx supabase functions deploy hello --project-ref qgzvkongdjqiiamzbbts
```
## local

USE VSCode Debug -> Deno


## Remote

```bash
curl --request POST 'https://qgzvkongdjqiiamzbbts.supabase.co/functions/v1/embedding' \
  --header 'Authorization: Bearer XXX' \
  --header 'Content-Type: application/json' \
  --data '{ "name":"Functions" }'
```
