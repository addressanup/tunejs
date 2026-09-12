import {app,BrowserWindow} from 'electron';
// Uses the exact browser example. Start the root npm run dev server first.
app.whenReady().then(async () => {
  const window=new BrowserWindow({width:960,height:860,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  await window.loadURL('http://127.0.0.1:4173');
  console.log(JSON.stringify({status:'loaded',electron:process.versions.electron,chrome:process.versions.chrome,url:window.webContents.getURL()}));
}).catch(error=>{console.error('Start the TuneJS development server first.',error);app.quit();});
app.on('window-all-closed',()=>app.quit());
