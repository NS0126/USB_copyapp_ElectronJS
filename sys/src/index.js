const electron = require('electron');
const app = electron.app;
app.commandLine.appendSwitch('ignore-certificate-errors');

const path = require('path');
const url = require('url');
const uuidv4 = require('uuid/v4');
const fs = require('fs');
const opn = require('opn');
const Worker = require('tiny-worker');

let mainWindow;
let workerThread;
const sessionId = uuidv4();

function createServerWorker(pserverjs, plocator, psessionId, puserAgent) {
    const worker = new Worker(() => {
        let server;

        function keepAlive() {
            self.postMessage(process.pid);
            (function keepAliveSub(){
                if (!server || server.keepAlive) {
                    setTimeout(keepAliveSub, 1000);
                }
            })();
        }

        self.onmessage = function(event) {
            server = require(event.data.serverjs);
            server.configure(event.data.locator);
            server.lockSession(event.data.sessionId,
                               event.data.userAgent);
            server.readUSBThenStart()
        }

        self.onerror = function(event) {
            console.log('ERROR ' + event);
        }

        postMessage('');
        setImmediate(() => keepAlive());
    });
    worker.postMessage({
        serverjs: pserverjs,
        locator: plocator,
        sessionId: psessionId,
        userAgent: puserAgent,
    });
    worker.onmessage = () => {};

    return worker;
}

function workerThreadRestart(code, serverjs, locator, sessionId, ua) {
    // exit if main process is gone
    if (!mainWindow) return;

    // The worker process does NOT PLAY WELL at all with
    // electron.  We need to keep restarting it.
    // console.log('Server died with code: ' + code + ', restarting');
    workerThread = createServerWorker(
        serverjs, locator, sessionId, ua,
    );

    workerThread.child.on('exit', (code) =>
        workerThreadRestart(
            code, serverjs, locator, sessionId, ua,
    ));
}

function createWindow() {
    const locator = findLocator();

    mainWindow = new electron.BrowserWindow({
        width: 800,
        height: 600,
        backgroundColor: '#666666',
        icon: path.join(__dirname, 'img/appicon.png'),
        show: false,
        devTools: false,
        webPreferences: {
            plugins: true
        }
    });

    // Start the server in a separate thread.
    workerThreadRestart(0,
        path.join(__dirname, 'server.js'),
        locator,
        sessionId,
        mainWindow.webContents.session.getUserAgent(),
    );

    //mainWindow.webContents.openDevTools();

    mainWindow
        .webContents.session.webRequest
        .onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['x-api-key'] =
            fs.readFileSync(path.join(locator.shared, '.hidfil.sys'))
              .toString('hex');
        details.requestHeaders['session-id'] = sessionId;
        callback({cancel:false, requestHeaders: details.requestHeaders});
    });

    // ipc connectors
    electron.ipcMain.on('openlocal-message', (ev, url) => {
        //console.log('Warning: Opening external URL in browser ' + url);
        mainWindow.loadURL(url);
    });
    electron.ipcMain.on('getlocator-message', (ev) => {
        ev.returnValue = locator;
    });

    // load start page
    mainWindow.loadURL(url.format({
        pathname: path.join(__dirname, 'index.html'),
        protocol: 'file:',
        slashes: true
    }));

    mainWindow.webContents.on('dom-ready', () => onDomReady(mainWindow));
    mainWindow.webContents.on('will-navigate', onOpenUrl);

    mainWindow.webContents.on('new-window', (event, url) => {
        event.preventDefault();
        var win = new electron.BrowserWindow({
            width: 800,
            height: 600,
            icon: path.join(__dirname, 'img/appicon.png'),
            webPreferences: {
                plugins: true
            }
        });
        win.loadURL(url);

        win.webContents.on('dom-ready', () => onDomReady(win));
        win.webContents.on('will-navigate', onOpenUrl);

        mainWindow.newGuest = win;
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        workerThread.terminate();
        process.exit(0);
    });

    mainWindow.webContents.once('did-finish-load', () => {
        mainWindow.maximize();
        mainWindow.show();

    });
}

function systemOpenUrl(url) {
    opn(url);
}

function onDomReady(win) {
    // Standard JS injection.
    // * remove the PDF toolbar to put roadblock against download
    // * provide callback for opening external URLs in
    //   the electron browser (insecure)
    win.webContents.executeJavaScript(
`
        const {ipcRenderer} = require('electron');
        if (typeof(window.jQuery) === 'undefined') {
            window.$ = window.jQuery = require('jquery');
        }
        $("[data-openlocal='true']").click(function(ev) {
            ev.preventDefault();
            // this will prevent triggering the onOpenUrl()
            // call below.
            ipcRenderer.send('openlocal-message', ev.target.href);
        });

        tb = document.querySelector('viewer-pdf-toolbar');
        if (tb) { tb.style.display = 'none'; }
`
    );
}

function findLocator() {
    const locatorFile = 'locator.json';
    let found = false;
    let dir = __dirname;
    do {
        if (fs.existsSync(path.join(dir, locatorFile))) {
            found = true;
            break;
        }
        if (path.dirname(dir) == dir) break;
        dir = path.resolve(dir,'..');
    } while(!found);

    if (!found) {
        throw new Error("can't find locator file: " + locatorFile);
    }

    var locator = require(path.join(dir, locatorFile));
    locator.shared = path.resolve(dir, locator.shared);
    locator.app = path.resolve(dir, locator.app);
    locator.drive = path.resolve(dir, locator.drive);
    //console.log('shared: ' + locator.shared);
    //console.log('app: ' + locator.app);
    //console.log('drive: ' + locator.drive);

    return locator;
}

function onOpenUrl(ev, url) {
    if (!url.match(/^https:\/\/localhost/)) {
        ev.preventDefault();
        //console.log('Warning: Opening external URL using system ' + url);
        systemOpenUrl(url);
    }
}

let notPrimary = app.makeSingleInstance(() => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.focus();
    }
});

if (notPrimary) {
    app.exit(0);
} else {
    app.on('ready', createWindow);
}

