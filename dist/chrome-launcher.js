/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const childProcess = require("child_process");
const fs = require("fs");
const net = require("net");
const rimraf = require("rimraf");
const chromeFinder = require("./chrome-finder");
const random_port_1 = require("./random-port");
const flags_1 = require("./flags");
const utils_1 = require("./utils");
const log = require('lighthouse-logger');
const spawn = childProcess.spawn;
const execSync = childProcess.execSync;
const isWsl = utils_1.getPlatform() === 'wsl';
const isWindows = utils_1.getPlatform() === 'win32';
const _SIGINT = 'SIGINT';
const _SIGINT_EXIT_CODE = 130;
const _SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32', 'wsl']);
const instances = new Set();
const sigintListener = () => __awaiter(this, void 0, void 0, function* () {
    for (const instance of instances) {
        try {
            yield instance.kill();
        }
        catch (err) {
        }
    }
    process.exit(_SIGINT_EXIT_CODE);
});
function launch(opts = {}) {
    return __awaiter(this, void 0, void 0, function* () {
        opts.handleSIGINT = utils_1.defaults(opts.handleSIGINT, true);
        const instance = new Launcher(opts);
        // Kill spawned Chrome process in case of ctrl-C.
        if (opts.handleSIGINT && instances.size === 0) {
            process.on(_SIGINT, sigintListener);
        }
        instances.add(instance);
        yield instance.launch();
        const kill = () => __awaiter(this, void 0, void 0, function* () {
            instances.delete(instance);
            if (instances.size === 0) {
                process.removeListener(_SIGINT, sigintListener);
            }
            return instance.kill();
        });
        const getChromeWebsocketUrl = () => {
            return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
                const promiseDelay = (delay) => new Promise(resolve => setTimeout(resolve, delay));
                const timeout = 10 * 1000; // in ms
                let promiseResolved = false;
                setTimeout(() => {
                    if (!promiseResolved) {
                        promiseResolved = true;
                        reject('Failed to get chrome websocket url - timeout');
                    }
                }, timeout);
                while (!promiseResolved) {
                    if (instance.chromeWebsocketUrl) {
                        promiseResolved = true;
                        resolve(instance.chromeWebsocketUrl);
                        break;
                    }
                    yield promiseDelay(100);
                }
            }));
        };
        return { pid: instance.pid, port: instance.port, kill, process: instance.chrome, getChromeWebsocketUrl };
    });
}
exports.launch = launch;
class Launcher {
    constructor(opts = {}, moduleOverrides = {}) {
        this.opts = opts;
        this.tmpDirandPidFileReady = false;
        this.fs = moduleOverrides.fs || fs;
        this.rimraf = moduleOverrides.rimraf || rimraf;
        this.spawn = moduleOverrides.spawn || spawn;
        log.setLevel(utils_1.defaults(this.opts.logLevel, 'silent'));
        // choose the first one (default)
        this.startingUrl = utils_1.defaults(this.opts.startingUrl, 'about:blank');
        this.chromeFlags = utils_1.defaults(this.opts.chromeFlags, []);
        this.requestedPort = utils_1.defaults(this.opts.port, 0);
        this.chromePath = this.opts.chromePath;
        this.enableExtensions = utils_1.defaults(this.opts.enableExtensions, false);
        this.connectionPollInterval = utils_1.defaults(this.opts.connectionPollInterval, 500);
        this.maxConnectionRetries = utils_1.defaults(this.opts.maxConnectionRetries, 50);
        this.envVars = utils_1.defaults(opts.envVars, Object.assign({}, process.env));
        if (typeof this.opts.userDataDir === 'boolean') {
            if (!this.opts.userDataDir) {
                this.useDefaultProfile = true;
                this.userDataDir = undefined;
            }
            else {
                throw new utils_1.InvalidUserDataDirectoryError();
            }
        }
        else {
            this.useDefaultProfile = false;
            this.userDataDir = this.opts.userDataDir;
        }
    }
    get flags() {
        let flags = flags_1.DEFAULT_FLAGS.concat([`--remote-debugging-port=${this.port}`]);
        // Place Chrome profile in a custom location we'll rm -rf later
        if (!this.useDefaultProfile) {
            // If in WSL, we need to use the Windows format
            flags.push(`--user-data-dir=${isWsl ? utils_1.toWinDirFormat(this.userDataDir) : this.userDataDir}`);
        }
        if (this.enableExtensions) {
            flags = flags.filter(flag => flag !== '--disable-extensions');
        }
        if (utils_1.getPlatform() === 'linux') {
            flags.push('--disable-setuid-sandbox');
        }
        flags.push(...this.chromeFlags);
        flags.push(this.startingUrl);
        return flags;
    }
    // Wrapper function to enable easy testing.
    makeTmpDir() {
        return utils_1.makeTmpDir();
    }
    prepare() {
        const platform = utils_1.getPlatform();
        if (!_SUPPORTED_PLATFORMS.has(platform)) {
            throw new utils_1.UnsupportedPlatformError();
        }
        this.userDataDir = this.userDataDir || this.makeTmpDir();
        this.outFile = this.fs.openSync(`${this.userDataDir}/chrome-out.log`, 'a+');
        this.errFile = this.fs.openSync(`${this.userDataDir}/chrome-err.log`, 'a+');
        this.chromeWebsocketUrl = '';
        // fix for Node4
        // you can't pass a fd to fs.writeFileSync
        this.pidFile = `${this.userDataDir}/chrome.pid`;
        log.verbose('ChromeLauncher', `created ${this.userDataDir}`);
        this.tmpDirandPidFileReady = true;
    }
    launch() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.requestedPort !== 0) {
                this.port = this.requestedPort;
                // If an explict port is passed first look for an open connection...
                try {
                    return yield this.isDebuggerReady();
                }
                catch (err) {
                    log.log('ChromeLauncher', `No debugging port found on port ${this.port}, launching a new Chrome.`);
                }
            }
            if (this.chromePath === undefined) {
                const installations = yield chromeFinder[utils_1.getPlatform()]();
                if (installations.length === 0) {
                    throw new utils_1.ChromeNotInstalledError();
                }
                this.chromePath = installations[0];
            }
            if (!this.tmpDirandPidFileReady) {
                this.prepare();
            }
            this.pid = yield this.spawnProcess(this.chromePath);
            return Promise.resolve();
        });
    }
    promiseDelay(delay) {
        return new Promise(resolve => setTimeout(resolve, delay));
    }
    _listenForWebsocketUrl() {
        return new Promise((resolve, reject) => __awaiter(this, void 0, void 0, function* () {
            const logPath = `${this.userDataDir}/chrome-err.log`;
            const timeout = 10 * 1000; // in ms
            let promiseResolved = false;
            setTimeout(() => {
                if (!promiseResolved) {
                    promiseResolved = true;
                    reject('Failed to FIND chrome websocket url - timeout');
                }
            }, timeout);
            while (!promiseResolved) {
                // @ts-ignore
                fs.readFile(logPath, 'utf8', (err, data) => __awaiter(this, void 0, void 0, function* () {
                    if (err) {
                        console.log(`[ChromeLauncher] Failed to readfile`, err);
                        return;
                    }
                    const lines = data.split('\n');
                    for (let index in lines) {
                        const line = lines[index];
                        if (line.startsWith('DevTools listening')) {
                            // @ts-ignore
                            this.chromeWebsocketUrl = line.match('(ws://.+)')[1].trim();
                            promiseResolved = true;
                            resolve(this.chromeWebsocketUrl);
                        }
                    }
                }));
                yield this.promiseDelay(100);
            }
        }));
    }
    spawnProcess(execPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const spawnPromise = (() => __awaiter(this, void 0, void 0, function* () {
                if (this.chrome) {
                    log.log('ChromeLauncher', `Chrome already running with pid ${this.chrome.pid}.`);
                    return this.chrome.pid;
                }
                // If a zero value port is set, it means the launcher
                // is responsible for generating the port number.
                // We do this here so that we can know the port before
                // we pass it into chrome.
                if (this.requestedPort === 0) {
                    this.port = yield random_port_1.getRandomPort();
                }
                log.verbose('ChromeLauncher', `Launching with command:\n"${execPath}" ${this.flags.join(' ')}`);
                this._listenForWebsocketUrl();
                const chrome = this.spawn(execPath, this.flags, { detached: true, stdio: ['ignore', this.outFile, this.errFile], env: this.envVars });
                this.chrome = chrome;
                this.fs.writeFileSync(this.pidFile, chrome.pid.toString());
                log.verbose('ChromeLauncher', `Chrome running with pid ${chrome.pid} on port ${this.port}.`);
                return chrome.pid;
            }))();
            const pid = yield spawnPromise;
            yield this.waitUntilReady();
            return pid;
        });
    }
    cleanup(client) {
        if (client) {
            client.removeAllListeners();
            client.end();
            client.destroy();
            client.unref();
        }
    }
    // resolves if ready, rejects otherwise
    isDebuggerReady() {
        return new Promise((resolve, reject) => {
            const client = net.createConnection(this.port);
            client.once('error', err => {
                this.cleanup(client);
                reject(err);
            });
            client.once('connect', () => {
                this.cleanup(client);
                resolve();
            });
        });
    }
    // resolves when debugger is ready, rejects after 10 polls
    waitUntilReady() {
        const launcher = this;
        return new Promise((resolve, reject) => {
            let retries = 0;
            let waitStatus = 'Waiting for browser.';
            const poll = () => {
                if (retries === 0) {
                    log.log('ChromeLauncher', waitStatus);
                }
                retries++;
                waitStatus += '..';
                log.log('ChromeLauncher', waitStatus);
                launcher.isDebuggerReady()
                    .then(() => {
                    log.log('ChromeLauncher', waitStatus + `${log.greenify(log.tick)}`);
                    resolve();
                })
                    .catch(err => {
                    if (retries > launcher.maxConnectionRetries) {
                        log.error('ChromeLauncher', err.message);
                        const stderr = this.fs.readFileSync(`${this.userDataDir}/chrome-err.log`, { encoding: 'utf-8' });
                        log.error('ChromeLauncher', `Logging contents of ${this.userDataDir}/chrome-err.log`);
                        log.error('ChromeLauncher', stderr);
                        return reject(err);
                    }
                    utils_1.delay(launcher.connectionPollInterval).then(poll);
                });
            };
            poll();
        });
    }
    kill() {
        return new Promise((resolve, reject) => {
            if (this.chrome) {
                this.chrome.on('close', () => {
                    delete this.chrome;
                    this.destroyTmp().then(resolve);
                });
                log.log('ChromeLauncher', `Killing Chrome instance ${this.chrome.pid}`);
                try {
                    if (isWindows) {
                        execSync(`taskkill /pid ${this.chrome.pid} /T /F`);
                    }
                    else {
                        process.kill(-this.chrome.pid);
                    }
                }
                catch (err) {
                    const message = `Chrome could not be killed ${err.message}`;
                    log.warn('ChromeLauncher', message);
                    reject(new Error(message));
                }
            }
            else {
                // fail silently as we did not start chrome
                resolve();
            }
        });
    }
    destroyTmp() {
        return new Promise(resolve => {
            // Only clean up the tmp dir if we created it.
            if (this.userDataDir === undefined || this.opts.userDataDir !== undefined) {
                return resolve();
            }
            if (this.outFile) {
                this.fs.closeSync(this.outFile);
                delete this.outFile;
            }
            if (this.errFile) {
                this.fs.closeSync(this.errFile);
                delete this.errFile;
            }
            this.rimraf(this.userDataDir, () => resolve());
        });
    }
}
exports.Launcher = Launcher;
;
exports.default = Launcher;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hyb21lLWxhdW5jaGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2Nocm9tZS1sYXVuY2hlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7OztHQUlHO0FBQ0gsWUFBWSxDQUFDOzs7Ozs7Ozs7O0FBQ2IsOENBQThDO0FBQzlDLHlCQUF5QjtBQUN6QiwyQkFBMkI7QUFDM0IsaUNBQWlDO0FBQ2pDLGdEQUFnRDtBQUNoRCwrQ0FBNEM7QUFDNUMsbUNBQXNDO0FBQ3RDLG1DQUFtSztBQUVuSyxNQUFNLEdBQUcsR0FBRyxPQUFPLENBQUMsbUJBQW1CLENBQUMsQ0FBQztBQUN6QyxNQUFNLEtBQUssR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDO0FBQ2pDLE1BQU0sUUFBUSxHQUFHLFlBQVksQ0FBQyxRQUFRLENBQUM7QUFDdkMsTUFBTSxLQUFLLEdBQUcsbUJBQVcsRUFBRSxLQUFLLEtBQUssQ0FBQztBQUN0QyxNQUFNLFNBQVMsR0FBRyxtQkFBVyxFQUFFLEtBQUssT0FBTyxDQUFDO0FBQzVDLE1BQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQztBQUN6QixNQUFNLGlCQUFpQixHQUFHLEdBQUcsQ0FBQztBQUM5QixNQUFNLG9CQUFvQixHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsUUFBUSxFQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQztBQUkxRSxNQUFNLFNBQVMsR0FBRyxJQUFJLEdBQUcsRUFBRSxDQUFDO0FBZ0M1QixNQUFNLGNBQWMsR0FBRyxHQUFTLEVBQUU7SUFDaEMsR0FBRyxDQUFDLENBQUMsTUFBTSxRQUFRLElBQUksU0FBUyxDQUFDLENBQUMsQ0FBQztRQUNqQyxJQUFJLENBQUM7WUFDSCxNQUFNLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUN4QixDQUFDO1FBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztRQUNmLENBQUM7SUFDSCxDQUFDO0lBQ0QsT0FB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