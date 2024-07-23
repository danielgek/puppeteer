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

import {Buffer} from 'node:buffer';
import type {Readable} from 'node:stream';

import type {Protocol} from 'devtools-protocol';

import type {ElementHandle} from '../api/ElementHandle.js';
import type {JSHandle} from '../api/JSHandle.js';
import {Page} from '../api/Page.js';
// import {isNode} from '../environment.js';
import {assert} from '../util/assert.js';
import {Deferred} from '../util/Deferred.js';
import {isErrorLike} from '../util/ErrorLike.js';

import type {CDPSession} from './Connection.js';
import {debug} from './Debug.js';
import {CDPElementHandle} from './ElementHandle.js';
import type {CommonEventEmitter} from './EventEmitter.js';
import type {ExecutionContext} from './ExecutionContext.js';
import {CDPJSHandle} from './JSHandle.js';

/**
 * @internal
 */
export const debugError = debug('puppeteer:error');

/**
 * @internal
 */
export function createEvaluationError(
  details: Protocol.Runtime.ExceptionDetails
): unknown {
  let name: string;
  let message: string;
  if (!details.exception) {
    name = 'Error';
    message = details.text;
  } else if (
    (details.exception.type !== 'object' ||
      details.exception.subtype !== 'error') &&
    !details.exception.objectId
  ) {
    return valueFromRemoteObject(details.exception);
  } else {
    const detail = getErrorDetails(details);
    name = detail.name;
    message = detail.message;
  }
  const messageHeight = message.split('\n').length;
  const error = new Error(message);
  error.name = name;
  const stackLines = error.stack!.split('\n');
  const messageLines = stackLines.splice(0, messageHeight);

  // The first line is this function which we ignore.
  stackLines.shift();
  if (details.stackTrace && stackLines.length < Error.stackTraceLimit) {
    for (const frame of details.stackTrace.callFrames.reverse()) {
      if (
        PuppeteerURL.isPuppeteerURL(frame.url) &&
        frame.url !== PuppeteerURL.INTERNAL_URL
      ) {
        const url = PuppeteerURL.parse(frame.url);
        stackLines.unshift(
          `    at ${frame.functionName || url.functionName} (${
            url.functionName
          } at ${url.siteString}, <anonymous>:${frame.lineNumber}:${
            frame.columnNumber
          })`
        );
      } else {
        stackLines.push(
          `    at ${frame.functionName || '<anonymous>'} (${frame.url}:${
            frame.lineNumber
          }:${frame.columnNumber})`
        );
      }
      if (stackLines.length >= Error.stackTraceLimit) {
        break;
      }
    }
  }

  error.stack = [...messageLines, ...stackLines].join('\n');
  return error;
}

/**
 * @internal
 */
export function createClientError(
  details: Protocol.Runtime.ExceptionDetails
): unknown {
  let name: string;
  let message: string;
  if (!details.exception) {
    name = 'Error';
    message = details.text;
  } else if (
    (details.exception.type !== 'object' ||
      details.exception.subtype !== 'error') &&
    !details.exception.objectId
  ) {
    return valueFromRemoteObject(details.exception);
  } else {
    const detail = getErrorDetails(details);
    name = detail.name;
    message = detail.message;
  }
  const messageHeight = message.split('\n').length;
  const error = new Error(message);
  error.name = name;

  const stackLines = [];
  const messageLines = error.stack!.split('\n').splice(0, messageHeight);
  if (details.stackTrace && stackLines.length < Error.stackTraceLimit) {
    for (const frame of details.stackTrace.callFrames.reverse()) {
      stackLines.push(
        `    at ${frame.functionName || '<anonymous>'} (${frame.url}:${
          frame.lineNumber
        }:${frame.columnNumber})`
      );
      if (stackLines.length >= Error.stackTraceLimit) {
        break;
      }
    }
  }

  error.stack = [...messageLines, ...stackLines].join('\n');
  return error;
}

const getErrorDetails = (details: Protocol.Runtime.ExceptionDetails) => {
  let name = '';
  let message: string;
  const lines = details.exception?.description?.split('\n    at ') ?? [];
  const size = Math.min(
    details.stackTrace?.callFrames.length ?? 0,
    lines.length - 1
  );
  lines.splice(-size, size);
  if (details.exception?.className) {
    name = details.exception.className;
  }
  message = lines.join('\n');
  if (name && message.startsWith(`${name}: `)) {
    message = message.slice(name.length + 2);
  }
  return {message, name};
};

/**
 * @internal
 */
const SOURCE_URL = Symbol('Source URL for Puppeteer evaluation scripts');

/**
 * @internal
 */
export class PuppeteerURL {
  static INTERNAL_URL = 'pptr:internal';

  static fromCallSite(
    functionName: string,
    site: NodeJS.CallSite
  ): PuppeteerURL {
    const url = new PuppeteerURL();
    url.#functionName = functionName;
    url.#siteString = site.toString();
    return url;
  }

  static parse = (url: string): PuppeteerURL => {
    url = url.slice('pptr:'.length);
    const [functionName = '', siteString = ''] = url.split(';');
    const puppeteerUrl = new PuppeteerURL();
    puppeteerUrl.#functionName = functionName;
    puppeteerUrl.#siteString = decodeURIComponent(siteString);
    return puppeteerUrl;
  };

  static isPuppeteerURL = (url: string): boolean => {
    return url.startsWith('pptr:');
  };

  #functionName!: string;
  #siteString!: string;

  get functionName(): string {
    return this.#functionName;
  }

  get siteString(): string {
    return this.#siteString;
  }

  toString(): string {
    return `pptr:${[
      this.#functionName,
      encodeURIComponent(this.#siteString),
    ].join(';')}`;
  }
}

/**
 * @internal
 */
export const withSourcePuppeteerURLIfNone = <T extends NonNullable<unknown>>(
  functionName: string,
  object: T
): T => {
  if (Object.prototype.hasOwnProperty.call(object, SOURCE_URL)) {
    return object;
  }
  const original = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, stack) => {
    // First element is the function. Second element is the caller of this
    // function. Third element is the caller of the caller of this function
    // which is precisely what we want.
    return stack[2];
  };
  const site = new Error().stack as unknown as NodeJS.CallSite;
  Error.prepareStackTrace = original;
  return Object.assign(object, {
    [SOURCE_URL]: PuppeteerURL.fromCallSite(functionName, site),
  });
};

/**
 * @internal
 */
export const getSourcePuppeteerURLIfAvailable = <
  T extends NonNullable<unknown>,
>(
  object: T
): PuppeteerURL | undefined => {
  if (Object.prototype.hasOwnProperty.call(object, SOURCE_URL)) {
    return object[SOURCE_URL as keyof T] as PuppeteerURL;
  }
  return undefined;
};

/**
 * @internal
 */
export function valueFromRemoteObject(
  remoteObject: Protocol.Runtime.RemoteObject
): any {
  assert(!remoteObject.objectId, 'Cannot extract value when objectId is given');
  if (remoteObject.unserializableValue) {
    if (remoteObject.type === 'bigint') {
      return BigInt(remoteObject.unserializableValue.replace('n', ''));
    }
    switch (remoteObject.unserializableValue) {
      case '-0':
        return -0;
      case 'NaN':
        return NaN;
      case 'Infinity':
        return Infinity;
      case '-Infinity':
        return -Infinity;
      default:
        throw new Error(
          'Unsupported unserializable value: ' +
            remoteObject.unserializableValue
        );
    }
  }
  return remoteObject.value;
}

/**
 * @internal
 */
export async function releaseObject(
  client: CDPSession,
  remoteObject: Protocol.Runtime.RemoteObject
): Promise<void> {
  if (!remoteObject.objectId) {
    return;
  }
  await client
    .send('Runtime.releaseObject', {objectId: remoteObject.objectId})
    .catch(error => {
      // Exceptions might happen in case of a page been navigated or closed.
      // Swallow these since they are harmless and we don't leak anything in this case.
      debugError(error);
    });
}

/**
 * @internal
 */
export interface PuppeteerEventListener {
  emitter: CommonEventEmitter;
  eventName: string | symbol;
  handler: (...args: any[]) => void;
}

/**
 * @internal
 */
export function addEventListener(
  emitter: CommonEventEmitter,
  eventName: string | symbol,
  handler: (...args: any[]) => void
): PuppeteerEventListener {
  emitter.on(eventName, handler);
  return {emitter, eventName, handler};
}

/**
 * @internal
 */
export function removeEventListeners(
  listeners: Array<{
    emitter: CommonEventEmitter;
    eventName: string | symbol;
    handler: (...args: any[]) => void;
  }>
): void {
  for (const listener of listeners) {
    listener.emitter.removeListener(listener.eventName, listener.handler);
  }
  listeners.length = 0;
}

/**
 * @internal
 */
export const isString = (obj: unknown): obj is string => {
  return typeof obj === 'string' || obj instanceof String;
};

/**
 * @internal
 */
export const isNumber = (obj: unknown): obj is number => {
  return typeof obj === 'number' || obj instanceof Number;
};

/**
 * @internal
 */
export const isPlainObject = (obj: unknown): obj is Record<any, unknown> => {
  return typeof obj === 'object' && obj?.constructor === Object;
};

/**
 * @internal
 */
export const isRegExp = (obj: unknown): obj is RegExp => {
  return typeof obj === 'object' && obj?.constructor === RegExp;
};

/**
 * @internal
 */
export const isDate = (obj: unknown): obj is Date => {
  return typeof obj === 'object' && obj?.constructor === Date;
};

/**
 * @internal
 */
export async function waitForEvent<T>(
  emitter: CommonEventEmitter,
  eventName: string | symbol,
  predicate: (event: T) => Promise<boolean> | boolean,
  timeout: number,
  abortPromise: Promise<Error> | Deferred<Error>
): Promise<T> {
  const deferred = Deferred.create<T>({
    message: `Timeout exceeded while waiting for event ${String(eventName)}`,
    timeout,
  });
  const listener = addEventListener(emitter, eventName, async event => {
    if (await predicate(event)) {
      deferred.resolve(event);
    }
  });

  try {
    const response = await Deferred.race<T | Error>([deferred, abortPromise]);
    if (isErrorLike(response)) {
      throw response;
    }

    return response;
  } catch (error) {
    throw error;
  } finally {
    removeEventListeners([listener]);
  }
}

/**
 * @internal
 */
export function createJSHandle(
  context: ExecutionContext,
  remoteObject: Protocol.Runtime.RemoteObject
): JSHandle | ElementHandle<Node> {
  if (remoteObject.subtype === 'node' && context._world) {
    return new CDPElementHandle(context, remoteObject, context._world.frame());
  }
  return new CDPJSHandle(context, remoteObject);
}

/**
 * @internal
 */
export function evaluationString(
  fun: Function | string,
  ...args: unknown[]
): string {
  if (isString(fun)) {
    assert(args.length === 0, 'Cannot evaluate a string with arguments');
    return fun;
  }

  function serializeArgument(arg: unknown): string {
    if (Object.is(arg, undefined)) {
      return 'undefined';
    }
    return JSON.stringify(arg);
  }

  return `(${fun})(${args.map(serializeArgument).join(',')})`;
}

/**
 * @internal
 */
export function addPageBinding(type: string, name: string): void {
  // This is the CDP binding.
  // @ts-expect-error: In a different context.
  const callCDP = globalThis[name];

  // We replace the CDP binding with a Puppeteer binding.
  Object.assign(globalThis, {
    [name](...args: unknown[]): Promise<unknown> {
      // This is the Puppeteer binding.
      // @ts-expect-error: In a different context.
      const callPuppeteer = globalThis[name];
      callPuppeteer.args ??= new Map();
      callPuppeteer.callbacks ??= new Map();

      const seq = (callPuppeteer.lastSeq ?? 0) + 1;
      callPuppeteer.lastSeq = seq;
      callPuppeteer.args.set(seq, args);

      callCDP(
        JSON.stringify({
          type,
          name,
          seq,
          args,
          isTrivial: !args.some(value => {
            return value instanceof Node;
          }),
        })
      );

      return new Promise((resolve, reject) => {
        callPuppeteer.callbacks.set(seq, {
          resolve(value: unknown) {
            callPuppeteer.args.delete(seq);
            resolve(value);
          },
          reject(value?: unknown) {
            callPuppeteer.args.delete(seq);
            reject(value);
          },
        });
      });
    },
  });
}

/**
 * @internal
 */
export function pageBindingInitString(type: string, name: string): string {
  return evaluationString(addPageBinding, type, name);
}

/**
 * @internal
 */
export async function waitWithTimeout<T>(
  promise: Promise<T>,
  taskName: string,
  timeout: number
): Promise<T> {
  const deferred = Deferred.create<never>({
    message: `waiting for ${taskName} failed: timeout ${timeout}ms exceeded`,
    timeout,
  });

  return await Deferred.race([promise, deferred]);
}

/**
 * @internal
 */
let fs: typeof import('fs/promises') | null = null;
/**
 * @internal
 */
export async function importFSPromises(): Promise<
  typeof import('fs/promises')
> {
  if (!fs) {
    try {
      fs = await import('fs/promises');
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(
          'Cannot write to a path outside of a Node-like environment. fs'
        );
      }
      throw error;
    }
  }
  return fs;
}

/**
 * @internal
 */
export async function getReadableAsBuffer(
  readable: Readable,
  path?: string
): Promise<Buffer | null> {
  const buffers = [];
  if (path) {
    throw new Error(
      'Cannot write to a path outside of a Node-like environment.'
    );
  } else {
    for await (const chunk of readable) {
      buffers.push(chunk);
    }
  }
  try {
    return Buffer.concat(buffers);
  } catch (error) {
    console.log(error);
    return null;
  }
}

/**
 * @internal
 */
export async function getReadableFromProtocolStream(
  client: CDPSession,
  handle: string
): Promise<Readable> {
  // TODO: Once Node 18 becomes the lowest supported version, we can migrate to
  // ReadableStream.
  // if (!isNode) {
  //   throw new Error('Cannot create a stream outside of Node.js environment.');
  // }

  const {Readable} = await import('node:stream');

  let eof = false;
  return new Readable({
    async read(size: number) {
      if (eof) {
        return;
      }

      try {
        const response = await client.send('IO.read', {handle, size});
        this.push(response.data, response.base64Encoded ? 'base64' : undefined);
        if (response.eof) {
          eof = true;
          await client.send('IO.close', {handle});
          this.push(null);
        }
      } catch (error) {
        if (isErrorLike(error)) {
          this.destroy(error);
          return;
        }
        throw error;
      }
    },
  });
}

/**
 * @internal
 */
export async function setPageContent(
  page: Pick<Page, 'evaluate'>,
  content: string
): Promise<void> {
  // We rely upon the fact that document.open() will reset frame lifecycle with "init"
  // lifecycle event. @see https://crrev.com/608658
  return page.evaluate(html => {
    document.open();
    document.write(html);
    document.close();
  }, content);
}

/**
 * @internal
 */
export function getPageContent(): string {
  let content = '';
  for (const node of document.childNodes) {
    switch (node) {
      case document.documentElement:
        content += document.documentElement.outerHTML;
        break;
      default:
        content += new XMLSerializer().serializeToString(node);
        break;
    }
  }

  return content;
}

/**
 * @internal
 */
export function validateDialogType(
  type: string
): 'alert' | 'confirm' | 'prompt' | 'beforeunload' {
  let dialogType = null;
  const validDialogTypes = new Set([
    'alert',
    'confirm',
    'prompt',
    'beforeunload',
  ]);

  if (validDialogTypes.has(type)) {
    dialogType = type;
  }
  assert(dialogType, `Unknown javascript dialog type: ${type}`);
  return dialogType as 'alert' | 'confirm' | 'prompt' | 'beforeunload';
}
