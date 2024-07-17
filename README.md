

### ⛩️ Puppeteer for Cloudflare Workers


# Contributing

Currently we need to patch the puppeteer-core package in order to run puppeteer on workers

There are two foldersm the `puppeteer-core-patches` have the original changes on the `puppeteer-core` package, `patches` folder contains the same changes but apply them on this lib node_modules folder

So if you want to make any contributions and you need to change something on the original `puppeteer-core` the work flow would be the following

 - 1. Clone original puppeteer repo
 - 2. Clone this repo
 - 3. Apply `puppeteer-core-patches` patches files onto the puppeteer repo
 - 4. Make your changes
 - 5. Install puppeteer-core on this lib from your local copy with your changes
 - 6. Test and if nessessary go to point 4
 - 7. Then on this repos change the `puppeteer-core` version on the package.json to the one on you local `puppeteer-core`
 - 8. Run `npx custompatch "puppeteer-core"` this will generate the pacth to apply to node_modules
 - 9. also update the pacth from the original changes on the `puppeteer-core`





