"use strict";

let bookmarkRevision = 0;
let importingBookmarks = false;
let refreshBookmarks;

for (const event of [
    "onCreated", "onRemoved", "onChanged", "onMoved", "onChildrenReordered", "onImportBegan", "onImportEnded"
]) {
    chrome.bookmarks[event].addListener(() => {
        bookmarkRevision++;
        window.bookmarqSnapshot = null;
        if (event === "onImportBegan") importingBookmarks = true;
        else if (event === "onImportEnded") importingBookmarks = false;
        if (!importingBookmarks) refreshBookmarks?.();
    });
}

const initialBookmarkRevision = bookmarkRevision;
let initialTreeReady = false;
let initialBookmarks = chrome.bookmarks.getTree().then(tree => {
    initialTreeReady = true;
    return tree;
}).catch(error => {
    console.error("Unable to load bookmarks.", error);
    return null;
});
