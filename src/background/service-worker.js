/**
 * ZeeML Smart Table, Grid & JSON-to-CSV Studio — Manifest V3 Background Service Worker
 * Official Workbench: https://zeeml.com/json-to-csv
 */
'use strict';

const CONTEXT_MENU_ID = 'zeeml-harvest-page-data';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Harvest Table, Grid or JSON with ZeeML',
      contexts: ['page', 'selection', 'link']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab || !tab.id) return;
  if (!tab.url || /^(?:chrome|edge|about|chrome-extension):/i.test(tab.url)) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [
        'engines/schema-intelligence.js',
        'engines/format-exporter.js',
        'engines/dom-harvester.js'
      ]
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        if (window.ZeeMLDomHarvester && typeof window.ZeeMLDomHarvester.showQuickExportToast === 'function') {
          window.ZeeMLDomHarvester.showQuickExportToast();
        }
      }
    });
  } catch (err) {
    console.warn('[ZeeML Harvester] Unable to inspect restricted page:', err);
  }
});
