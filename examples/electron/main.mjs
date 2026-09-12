import {app,BrowserWindow} from 'electron';
// Uses the exact browser example. Start the root npm run dev server first.
// Automation hooks (used by the workload validation runs): TUNEJS_AUTOPLAY=1 relaxes the autoplay
// policy, TUNEJS_URL overrides the loaded page. Defaults are unchanged when unset.
if (process.env.TUNEJS_AUTOPLAY === '1') app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const target = process.env.TUNEJS_URL ?? 'http://127.0.0.1:4173';
app.whenReady().then(async () => {
  const window=new BrowserWindow({width:960,height:860,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  await window.loadURL(target);
  console.log(JSON.stringify({status:'loaded',electron:process.versions.electron,chrome:process.versions.chrome,url:window.webContents.getURL()}));
}).catch(error=>{console.error('Start the TuneJS development server first.',error);app.quit();});
app.on('window-all-closed',()=>app.quit());
