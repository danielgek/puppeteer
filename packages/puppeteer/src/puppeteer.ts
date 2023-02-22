/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export {Protocol} from 'puppeteer-core';

export * from 'puppeteer-core/internal/puppeteer-core.js';

import {PuppeteerNode} from 'puppeteer-core/internal/node/PuppeteerNode.js';

import {getConfiguration} from './getConfiguration.js';

const configuration = getConfiguration();

/**
 * @public
 */
// const puppeteer = new PuppeteerNode({
//   isPuppeteerCore: false,
//   configuration,
// });

/* Original singleton and exports
 * We redefine below
export const {

  connect,
  defaultArgs,
  executablePath,
  launch,
  trimCache,
} = puppeteer;

export default puppeteer;
*/

// We can't include both workers-types and dom because they conflict
declare global {
  interface Response {
    readonly webSocket: WebSocket | null;
  }
  interface WebSocket {
    accept(): void;
  }
}

export interface BrowserWorker {
  fetch: typeof fetch;
}

class PuppeteerWorkers extends Puppeteer {
  public constructor() {
    super({isPuppeteerCore: true});
    this.connect = this.connect.bind(this);
    this.launch = this.launch.bind(this);
  }

  public async launch(endpoint: BrowserWorker | string): Promise<Browser> {
    const res =
      typeof endpoint === 'string'
        ? await fetch(endpoint)
        : await endpoint.fetch('/acquire');
    const status = res.status;
    if (status != 200) {
      const message = await res.text();
      throw new Error(
        `Unabled to create new browser: code: ${status}: message: ${message}`
      );
    }
    const wsUrl = await res.text();
    const sessionId = this.extractSession(wsUrl);
    const transport = await WorkersWebSocketTransport.create(wsUrl, sessionId);
    return this.connect({transport, sessionId});
  }

  public async connectLocal(wsUrl: string): Promise<Browser> {
    const transport = await WorkersWebSocketTransport.create(wsUrl, 'local');
    return this.connect({transport});
  }

  extractSession(wsUrl: string): string {
    const u = new URL(wsUrl);
    return u.searchParams.get('browser_session') || 'unknown';
  }
}

const puppeteer = new PuppeteerWorkers();
export default puppeteer;

export const {connect, launch} = puppeteer;
