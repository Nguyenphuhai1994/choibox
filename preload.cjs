const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('choibox',{configuration:()=>ipcRenderer.invoke('choibox:config'),connect:c=>ipcRenderer.invoke('choibox:connect',c),chooseData:()=>ipcRenderer.invoke('choibox:choose-data')});
