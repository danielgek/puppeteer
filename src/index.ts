import { PuppeteerWorkers } from './PuppeteerWorkers.js'

export * from './PuppeteerWorkers.js'
export * from 'puppeteer-core'

export { BrowserWorker } from './BrowserWorker.js'

const puppeteer = new PuppeteerWorkers()
export const { connect, history, launch, limits, sessions } = puppeteer
export default puppeteer
