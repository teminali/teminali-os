const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

const logFile = path.join(app.getPath("userData"), "studio-main.log");
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch (e) {}
  console.log(...args);
}

log("Teminali Studio main process starting...");
log("App path:", app.getAppPath());
log("UserData path:", app.getPath("userData"));
log("IsPackaged:", app.isPackaged);

let mainWindow = null;

function createWindow() {
  log("Creating BrowserWindow...");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: "#08090E",
    title: "Teminali Studio",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    log("Window ready to show, displaying mainWindow");
    mainWindow.show();
  });

  const indexPath = path.join(__dirname, "../dist/index.html");
  log("Computed indexPath:", indexPath, "exists:", fs.existsSync(indexPath));

  if (!app.isPackaged && process.env.ELECTRON_DEV) {
    log("Loading DEV URL http://localhost:3000");
    mainWindow.loadURL("http://localhost:3000").catch((err) => {
      log("Failed to load dev URL, falling back to file:", err.message);
      mainWindow.loadFile(indexPath);
    });
  } else {
    log("Loading production file:", indexPath);
    mainWindow.loadFile(indexPath).catch((err) => {
      log("Failed to load dist/index.html:", err.message);
      mainWindow.loadURL("http://localhost:3000").catch(() => {});
    });
  }

  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
    log("did-fail-load:", errorCode, errorDescription);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    log("MainWindow closed");
    mainWindow = null;
  });
}

process.on("uncaughtException", (err) => {
  log("UNCAUGHT EXCEPTION:", err.stack || err.message);
});

process.on("unhandledRejection", (reason) => {
  log("UNHANDLED REJECTION:", reason);
});

app.whenReady().then(() => {
  log("app.whenReady resolved");
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  log("window-all-closed");
  if (process.platform !== "darwin") app.quit();
});
