# Bookmarq privacy policy

Bookmarq 1.0.0 shows your Chrome bookmarks on the New Tab page. It processes bookmark titles, addresses, folder names and search terms in your browser. The extension has no analytics, advertising or service that receives a copy of your bookmarks or searches.

## Bookmarks and search

Bookmarq uses Chrome's bookmarks API to read folders and links available in your profile, show them in columns and suggest matches as you type. If Chrome makes both local and account bookmarks available, Bookmarq can read both. Chrome manages any bookmark synchronization you have enabled.

The extension uses your search text to find saved titles. It keeps no search log and does not record the pages you visit.

## What stays in memory

While a Bookmarq tab is loaded, it can keep the names, identifiers and addresses needed for its initial bookmark columns in that tab's memory. A new Bookmarq tab can reuse these columns and checks current bookmarks with Chrome. The extension does not write this copy to disk or session storage. Once all Bookmarq tabs have closed or Chrome has unloaded them, the next tab reads its columns from Chrome again.

## Saved settings and deletion

Bookmarq saves your preferences for bookmark search, website icons and where links open in its local web storage in your Chrome profile. You can change them in Settings. They persist between browser restarts.

To reset the preferences while keeping the extension, close all but one Bookmarq tab. In that tab, open Chrome DevTools, choose Application, then Storage and Local storage. Clear the entries for the extension origin and close the tab. Chrome's general browsing-data cleanup preserves the extension's local storage.

Removing Bookmarq or clearing its local data leaves your Chrome bookmarks intact. You can edit or delete the bookmarks themselves in Chrome's bookmark manager.

## Opening a website

Loading the Bookmarq interface makes no requests to an external server. Scripts, styles and built-in images are packaged with the extension. Website icons, when enabled, are requested through an internal Chrome address. When you select a bookmark, Chrome opens the chosen address. That site receives a normal visit under your browser's settings.

## Limited Use and contact

Bookmarq follows the Chrome Web Store User Data Policy, including its Limited Use rules, when it uses information obtained through Google APIs. The publisher does not sell bookmark or search data or use it for advertising, credit decisions or lending.

For privacy questions, use the developer contact in the Bookmarq listing on the Chrome Web Store.
