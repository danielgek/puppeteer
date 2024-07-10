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

// import {initializePuppeteer} from './initializePuppeteer.js';
import {Browser} from './common/Browser.js';
import {BrowserWorker} from './common/BrowserWorker.js';
import {Puppeteer} from './common/Puppeteer.js';
import {WorkersWebSocketTransport} from './common/WorkersWebSocketTransport.js';

export * from './common/NetworkConditions.js';
export * from './common/QueryHandler.js';
export * from './common/DeviceDescriptors.js';
export * from './common/Errors.js';
export {BrowserWorker} from './common/BrowserWorker.js';

// initializePuppeteer('puppeteer-core');

const FAKE_HOST = 'https://fake.host';

/* Original singleton and exports
 * We redefine below
export const {
  connect,
  createBrowserFetcher,
  defaultArgs,
  executablePath,
  launch,
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

interface AcquireResponse {
  sessionId: string;
}

class PuppeteerWorkers extends Puppeteer {
  public constructor() {
    super({isPuppeteerCore: true});
    this.connect = this.connect.bind(this);
    this.launch = this.launch.bind(this);
    this.sessions = this.sessions.bind(this);
    this.history = this.history.bind(this);
    this.limits = this.limits.bind(this);
  }

  /**
   * Launch a browser session.
   *
   * @param endpoint - Cloudflare worker binding
   * @returns a browser session or throws
   */
  public async launch(
    endpoint: BrowserWorker,
    options?: LaunchOptions
  ): Promise<Browser> {
    let acquireUrl = `${FAKE_HOST}/v1/acquire`;
    if (options?.keep_alive) {
      acquireUrl = `${acquireUrl}?keep_alive=${options.keep_alive}`;
    }
    const res = await endpoint.fetch(acquireUrl);
    const status = res.status;
    const text = await res.text();
    if (status !== 200) {
      throw new Error(
        `Unabled to create new browser: code: ${status}: message: ${text}`
      );
    }
    // Got a 200, so response text is actually an AcquireResponse
    const response: AcquireResponse = JSON.parse(text);
    const transport = await WorkersWebSocketTransport.create(
      endpoint,
      response.sessionId
    );
    return this.connect({transport, sessionId: response.sessionId});
  }
}

const puppeteer = new PuppeteerWorkers();
export default puppeteer;

export const {connect, launch, sessions, history, limits} = puppeteer;
