// The fixed parts of the page (the elements in index.html) and the getElementById shortcut.

export const $ = id => document.getElementById(id);
export const appView = $("appView"), caseDrawer = $("caseDrawer"), drawerBackdrop = $("drawerBackdrop"), modalBackdrop = $("modalBackdrop"), modal = $("modal"), toastRegion = $("toastRegion");
