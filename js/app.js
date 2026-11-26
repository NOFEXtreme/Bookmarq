"use strict";

const animations = new Map();
let animationFrame = 0;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

function revealColumns(board) {
    if (document.hidden || document.wasDiscarded || reducedMotion.matches) return;
    const animation = board.animate([{opacity: 0}, {opacity: 1}], {duration: 100, easing: "ease-out"});
    const listeners = new AbortController();
    const finish = () => animation.finish();
    document.addEventListener("visibilitychange", finish, {signal: listeners.signal});
    reducedMotion.addEventListener("change", finish, {signal: listeners.signal});
    animation.onfinish = animation.oncancel = () => listeners.abort();
}

function i18n(key) {
    return chrome.i18n.getMessage(key) || key;
}

function openUrl(url, background = false) {
    const request = background || localStorage.target === "_blank"
        ? chrome.tabs.create({url, active: !background}) : chrome.tabs.update({url});
    request.catch(() => { /* Chrome rejects unsupported navigation targets. */ });
}

function setProperties(element, properties) {
    for (const [name, value] of Object.entries(properties)) {
        element.style[name] = name === "opacity" ? String(value) : `${value}px`;
    }
}

function stopAnimation(element, finish = false) {
    const animation = animations.get(element);
    if (!animation) return;
    animations.delete(element);
    if (finish) {
        setProperties(element, animation.target);
        animation.step?.(1);
        animation.complete?.();
    }
}

function animate(element, target, duration, complete, step) {
    stopAnimation(element);
    if (reducedMotion.matches) {
        setProperties(element, target);
        step?.(1);
        complete?.();
        return;
    }
    const style = getComputedStyle(element);
    const from = {};
    for (const name of Object.keys(target)) from[name] = Number.parseFloat(style[name]) || 0;
    animations.set(element, {from, target, duration, complete, step, start: performance.now()});
    if (!animationFrame) animationFrame = requestAnimationFrame(tick);
}

function tick(now) {
    animationFrame = 0;
    for (const [element, animation] of animations) {
        if (!element.isConnected) {
            animations.delete(element);
            continue;
        }
        const progress = Math.max(0, Math.min(1, (now - animation.start) / animation.duration));
        const eased = (1 - Math.cos(progress * Math.PI)) / 2;
        const values = {};
        for (const [name, value] of Object.entries(animation.target)) {
            values[name] = animation.from[name] + (value - animation.from[name]) * eased;
        }
        setProperties(element, values);
        animation.step?.(eased);
        if (progress === 1) {
            animations.delete(element);
            animation.complete?.();
        }
    }
    if (animations.size && !animationFrame) animationFrame = requestAnimationFrame(tick);
}

function createIcon(className) {
    const icon = document.createElement("span");
    icon.className = `favicon ${className}`;
    icon.setAttribute("aria-hidden", "true");
    return icon;
}

function createFavicon(pageUrl) {
    if (!pageUrl) return createIcon("folder-icon");
    if (localStorage.faviconDisplayed === "0") return null;
    const url = new URL(chrome.runtime.getURL("_favicon/"));
    url.searchParams.set("pageUrl", pageUrl);
    url.searchParams.set("size", "16");
    const icon = document.createElement("img");
    icon.className = "favicon";
    icon.alt = "";
    icon.width = icon.height = 16;
    icon.src = url.href;
    icon.addEventListener("error", () => icon.replaceWith(createIcon("link-icon")), {once: true});
    return icon;
}

function formatTitle(title, maxLength = 23) {
    const text = String(title ?? "").trimStart();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

const BookmarksModule = {
    containers: new Map(),
    moves: new Map(),
    activeContainer: null,
    gutter: 30,
    resizePending: false,
    buildRequestId: 0,
    introPlayed: false,

    restore() {
        for (const view of chrome.extension.getViews({type: "tab"})) {
            try {
                const snapshot = view.bookmarqSnapshot;
                if (!snapshot) continue;
                const saved = JSON.parse(snapshot);
                if (saved?.language !== document.documentElement.lang || !Array.isArray(saved.columns)) continue;
                this.render(saved.columns, snapshot);
                return;
            } catch { /* A closing view need not delay the authoritative bookmark request. */ }
        }
    },

    render(columns, snapshot) {
        const fragment = document.createDocumentFragment();
        for (const column of columns) {
            const container = this.createContainer(column.title, column.id);
            const list = container.querySelector("ul");
            for (const node of column.children) list.append(this.createEntry(node));
            fragment.append(container);
        }
        this.element.replaceChildren(fragment);
        this.snapshot = snapshot;
        this.element.style.display = this.containers.size ? "block" : "none";
        this.layout(false, true);
        if (this.containers.size && !this.introPlayed) {
            this.introPlayed = true;
            revealColumns(this.element);
        }
    },

    reconcile(columns, tree, snapshot) {
        const ids = new Set(columns.map(column => column.id));
        const existing = new Map();
        let relayout = this.resizePending;
        let busy = false;
        let visited = false;
        for (const [card, state] of this.containers) {
            if (ids.has(state.rootId)) {
                existing.set(state.rootId, card);
                busy ||= state.busy;
                visited ||= state.back.length > 0 || state.forward.length > 0;
                continue;
            }
            this.moves.get(card)?.cancel();
            this.moves.delete(card);
            this.containers.delete(card);
            if (this.activeContainer === card) this.activeContainer = null;
            card.remove();
            relayout = true;
        }
        this.pendingBoard = null;
        if (busy) {
            this.resizePending = relayout;
            const revision = bookmarkRevision;
            this.pendingBoard = () => {
                this.pendingBoard = null;
                if (revision === bookmarkRevision) this.reconcile(columns, tree, snapshot);
            };
            return;
        }
        const folders = new Map();
        if (visited) {
            const pending = [...tree];
            while (pending.length) {
                const folder = pending.pop();
                folders.set(folder.id, folder);
                for (const child of folder.children || []) if (child.children) pending.push(child);
            }
        }
        const ordered = new Map();
        let ahead = this.element.firstElementChild;
        for (const column of columns) {
            const card = existing.get(column.id) || this.createContainer(column.title, column.id);
            const state = this.containers.get(card);
            state.rootTitle = column.title;
            if (visited) {
                state.back = state.back.filter(id => folders.has(id));
                state.forward = state.forward.filter(id => folders.has(id));
                if (!folders.has(state.currentId)) state.currentId = state.back.pop() || state.rootId;
            }
            const folder = state.currentId === state.rootId ? column : folders.get(state.currentId);
            this.setHeading(card, folder.title, state.back.length > 0);
            const list = card.querySelector("ul");
            const rows = list.children;
            const changed = rows.length !== folder.children.length + 1 || folder.children.some((node, index) => {
                const entry = rows[index + 1].firstElementChild;
                return entry.dataset.nodeId !== node.id || entry.getAttribute("href") !== (node.url || null) ||
                    entry.lastElementChild.textContent !== this.entryTitle(node);
            });
            if (changed) {
                if (rows.length !== folder.children.length + 1) {
                    card.style.height = "";
                    relayout = true;
                }
                this.syncEntries(list, folder.children);
            }
            if (card !== ahead) {
                if (card.parentElement) this.element.moveBefore(card, ahead);
                else this.element.insertBefore(card, ahead);
                relayout = true;
            }
            ahead = card.nextElementSibling;
            ordered.set(card, state);
        }
        this.containers = ordered;
        this.snapshot = snapshot;
        this.element.style.display = ordered.size ? "block" : "none";
        if (relayout) this.layout(false, true);
    },

    async build(request, revision = bookmarkRevision) {
        if (!request && (document.hidden || importingBookmarks)) return;
        this.requestedRevision = revision;
        const requestId = ++this.buildRequestId;
        try {
            const tree = await (request || chrome.bookmarks.getTree());
            if (requestId !== this.buildRequestId || importingBookmarks) return;
            if (!tree) {
                this.requestedRevision = -1;
                return;
            }
            if (revision !== bookmarkRevision) return this.build();

            const roots = tree[0]?.children || [];
            const bars = roots.filter(node => node.folderType === "bookmarks-bar");
            const others = roots.filter(node => node.folderType === "other");
            const label = (root, title, count) => count > 1
                ? `${i18n(root.syncing ? "storageAccount" : "storageLocal")}: ${title}` : title;
            const columns = [];
            for (const bar of bars) {
                let standaloneList;
                for (const node of bar.children || []) {
                    if (node.url) {
                        if (!standaloneList) {
                            standaloneList = [];
                            columns.push({id: bar.id, title: label(bar, i18n("bmBarTitle"), bars.length),
                                children: standaloneList});
                        }
                        standaloneList.push(this.entryData(node));
                    } else {
                        columns.push({id: node.id, title: label(bar, node.title, bars.length),
                            children: (node.children || []).map(child => this.entryData(child))});
                    }
                }
            }
            for (const other of others) {
                if (!other.children?.length) continue;
                columns.push({id: other.id, title: label(other, i18n("obmTitle"), others.length),
                    children: other.children.map(node => this.entryData(node))});
            }
            const snapshot = JSON.stringify({language: document.documentElement.lang, columns});
            const visiting = [...this.containers.values()].some(state =>
                state.busy || state.back.length || state.forward.length);
            if (this.snapshot !== snapshot || visiting) {
                if (this.containers.size) this.reconcile(columns, tree, snapshot);
                else this.render(columns, snapshot);
            }
            window.bookmarqSnapshot = snapshot;
        } catch (error) {
            if (requestId === this.buildRequestId) {
                this.requestedRevision = -1;
                console.error("Unable to load bookmarks.", error);
            }
        }
    },

    entryData(node) {
        return node.url ? {id: node.id, title: node.title, url: node.url} : {id: node.id, title: node.title};
    },

    createContainer(title, id) {
        const container = document.createElement("div");
        container.className = "cont";
        const header = document.createElement("div");
        header.className = "group-header";
        const heading = document.createElement("div");
        heading.className = "group_title";
        heading.textContent = heading.title = title.trimStart();
        const action = document.createElement("button");
        action.className = "group-actions";
        action.type = "button";
        action.title = i18n("openFolderLinksHelp");
        action.setAttribute("aria-label", i18n("openFolderLinksLabel"));
        header.append(heading, action);
        container.append(header, this.createList());
        this.containers.set(container,
            {rootId: id, currentId: id, rootTitle: title, back: [], forward: [], busy: false});
        return container;
    },

    createList() {
        const list = document.createElement("ul");
        const indicator = document.createElement("li");
        indicator.className = "indicator";
        indicator.setAttribute("aria-hidden", "true");
        list.append(indicator);
        return list;
    },

    entryTitle(node) {
        let title = node.title;
        if (node.url && !title) {
            try { title = new URL(node.url).hostname.replace(/^www\./, "") || node.url; } catch { title = node.url; }
        }
        return formatTitle(title, node.url ? 23 : 16);
    },

    refreshIcons() {
        const show = localStorage.faviconDisplayed !== "0";
        for (const link of document.querySelectorAll("#bookmarks-module a.bookmark-entry, #searchSuggestions a")) {
            const icon = link.querySelector(".favicon");
            if (!show) icon?.remove();
            else if (!icon) link.prepend(createFavicon(link.getAttribute("href")));
        }
    },

    createEntry(node) {
        const entry = document.createElement(node.url ? "a" : "button");
        entry.className = "bookmark-entry";
        entry.dataset.nodeId = node.id;
        entry.dataset.linkType = node.url ? "link" : "folder";
        if (node.url) entry.href = node.url;
        else {
            entry.type = "button";
            entry.dataset.folderId = node.id;
        }
        const icon = createFavicon(node.url);
        if (icon) entry.append(icon);
        const text = document.createElement("span");
        text.className = "bookmark-title";
        text.textContent = this.entryTitle(node);
        entry.append(text);
        const item = document.createElement("li");
        item.append(entry);
        return item;
    },

    syncEntries(list, nodes) {
        const remaining = new Map();
        let previous = list.firstElementChild;
        for (let row = previous.nextElementSibling; row; row = row.nextElementSibling) {
            remaining.set(row.firstElementChild.dataset.nodeId, row);
        }
        for (const node of nodes) {
            let row = remaining.get(node.id);
            remaining.delete(node.id);
            const entry = row?.firstElementChild;
            if (entry && entry.getAttribute("href") === (node.url || null)) {
                const title = this.entryTitle(node);
                if (entry.lastElementChild.textContent !== title) entry.lastElementChild.textContent = title;
            } else {
                row?.remove();
                row = this.createEntry(node);
            }
            const next = previous.nextElementSibling;
            if (row !== next) {
                if (row.parentElement) list.moveBefore(row, next);
                else list.insertBefore(row, next);
            }
            previous = row;
        }
        for (const row of remaining.values()) row.remove();
    },

    calculateGutter(width, columnWidth) {
        for (let columns = Math.floor((width + 20) / (columnWidth + 20)); columns > 1; columns--) {
            const gutter = (width - columnWidth * columns) / (columns - 1);
            if (gutter > 30) break;
            if (gutter >= 20) return gutter;
        }
        return 30;
    },

    layout(moving = true, recalculateGutter = false) {
        if (!this.containers.size) return;
        if ([...this.containers.values()].some(state => state.busy)) {
            this.resizePending = true;
            return;
        }
        const elements = [...this.containers.keys()];
        const style = getComputedStyle(this.element);
        const top = Number.parseFloat(style.paddingTop);
        const left = Number.parseFloat(style.paddingLeft);
        const parentWidth = Number.parseFloat(getComputedStyle(this.element.parentElement).width);
        const first = getComputedStyle(elements[0]);
        const width = Number.parseFloat(first.width);
        const margin = Number.parseFloat(first.marginBottom);
        if (recalculateGutter) this.gutter = this.calculateGutter(parentWidth, width);
        const stride = width + this.gutter;
        const excess = stride - (parentWidth + this.gutter) % stride;
        const round = excess && excess < 1 ? Math.round : Math.floor;
        const columns = Math.max(1, Math.min(elements.length, round((parentWidth + this.gutter) / stride)));
        const heights = elements.map(element => element.offsetHeight + margin);
        const previous = moving && !reducedMotion.matches && elements.map(element => {
            const computed = getComputedStyle(element);
            const transform = new DOMMatrixReadOnly(computed.transform);
            return {left: Number.parseFloat(computed.left) + transform.m41,
                top: Number.parseFloat(computed.top) + transform.m42};
        });
        const bottoms = Array(columns).fill(0);
        for (const [index, element] of elements.entries()) {
            const column = bottoms.indexOf(Math.min(...bottoms));
            const x = column * stride + left;
            const y = bottoms[column] + top;
            const state = this.containers.get(element);
            state.top = y;
            state.height = heights[index] - margin;
            this.moves.get(element)?.cancel();
            this.moves.delete(element);
            element.style.left = `${x}px`;
            element.style.top = `${y}px`;
            if (previous && (previous[index].left !== x || previous[index].top !== y)) {
                const from = `translate(${previous[index].left - x}px, ${previous[index].top - y}px)`;
                const move = element.animate([{transform: from}, {transform: "translate(0, 0)"}],
                    {duration: 400, easing: first.transitionTimingFunction});
                this.moves.set(element, move);
                move.onfinish = () => {
                    if (this.moves.get(element) !== move) return;
                    move.cancel();
                    this.moves.delete(element);
                };
            }
            bottoms[column] += heights[index];
        }
        this.element.style.width = `${columns * stride - this.gutter + left + Number.parseFloat(style.paddingRight)}px`;
        this.element.style.height = `${Math.max(...bottoms) + top + Number.parseFloat(style.paddingBottom)}px`;
        this.resizePending = false;
    },

    fitHeight() {
        if (!this.containers.size) return;
        let bottom = 0;
        for (const state of this.containers.values()) bottom = Math.max(bottom, state.top + state.height);
        const first = this.element.firstElementChild;
        const margin = Number.parseFloat(getComputedStyle(first).marginBottom);
        const padding = Number.parseFloat(getComputedStyle(this.element).paddingBottom);
        this.element.style.height = `${bottom + margin + padding}px`;
    },

    setHeading(card, title, canGoBack) {
        const heading = card.querySelector(".group_title");
        const text = title.trimStart();
        if (heading.textContent !== text) heading.textContent = heading.title = text;
        const back = card.querySelector(".group_back");
        if (!canGoBack) back?.remove();
        else if (!back) {
            const button = document.createElement("button");
            button.className = "group_back";
            button.type = "button";
            button.setAttribute("aria-label", i18n("backLabel"));
            heading.before(button);
        }
    },

    navigate(direction, preferred) {
        const candidates = new Set([preferred, this.activeContainer,
            ...this.element.querySelectorAll(".cont:hover"), ...this.containers.keys()]);
        for (const container of candidates) {
            if (container && this.containers.get(container)?.[direction].length) {
                return this.updateContainer(container, null, direction);
            }
        }
        return false;
    },

    async readFolder(folderId, container, state) {
        while (this.containers.get(container) === state) {
            const revision = bookmarkRevision;
            const [children, folders] = await Promise.all([
                chrome.bookmarks.getChildren(folderId), chrome.bookmarks.get(folderId)
            ]);
            if (this.containers.get(container) !== state) return null;
            if (revision !== bookmarkRevision && !importingBookmarks) continue;
            if (!folders[0]) throw new Error("Bookmark folder is unavailable.");
            return {children, title: folders[0].title, revision};
        }
        return null;
    },

    updateContainer(container, requestedId, mode) {
        const state = this.containers.get(container);
        if (!state || state.busy) return false;
        const back = [...state.back];
        const forward = [...state.forward];
        let folderId = requestedId;
        if (mode === "push") {
            if (!folderId || folderId === state.currentId) return false;
            back.push(state.currentId);
            forward.length = 0;
        } else if (mode === "back") {
            folderId = back.pop();
            if (!folderId) return false;
            forward.push(state.currentId);
        } else if (mode === "forward") {
            folderId = forward.pop();
            if (!folderId) return false;
            back.push(state.currentId);
        } else return false;
        state.busy = true;
        this.activeContainer = container;
        this.readFolder(folderId, container, state).then(folder => {
            if (!folder) return;
            const oldList = container.querySelector("ul");
            const newList = this.createList();
            newList.querySelector(".indicator").style.top = oldList.querySelector(".indicator").style.top;
            for (const node of folder.children) newList.append(this.createEntry(node));
            const previousHeight = container.offsetHeight;
            const previousContent = container.style.height ? previousHeight : container.clientHeight;
            const headerHeight = container.querySelector(".group-header").offsetHeight;
            container.style.height = `${previousHeight}px`;
            Object.assign(oldList.style, {position: "absolute", left: "0px", top: `${headerHeight}px`, width: "100%"});
            container.append(newList);
            const targetHeight = headerHeight + newList.offsetHeight;
            const heightChange = targetHeight - previousContent;
            const offset = mode === "back" ? 200 : -200;
            Object.assign(newList.style,
                {position: "absolute", left: `${-offset}px`, top: `${headerHeight}px`, width: "100%"});
            animate(newList, {left: 0}, 260);
            state.height = targetHeight;
            const below = [...this.containers].filter(([other, peer]) =>
                other.style.left === container.style.left && peer.top > state.top);
            let moved = 0;
            animate(container, {height: targetHeight}, 260, undefined, progress => {
                // Each changing card contributes its own displacement to rows below in the same frame.
                const displacement = heightChange * progress;
                for (const [other, peer] of below) {
                    peer.top += displacement - moved;
                    other.style.top = `${peer.top}px`;
                }
                moved = displacement;
            });
            animate(oldList, {left: offset}, 260, () => {
                oldList.remove();
                newList.removeAttribute("style");
                container.style.height = `${targetHeight}px`;
                Object.assign(state, {currentId: folderId, back, forward, busy: false});
                const title = folderId === state.rootId ? state.rootTitle : folder.title;
                this.setHeading(container, title, back.length > 0);
                if (this.pendingBoard) this.pendingBoard();
                if (folder.revision !== bookmarkRevision && this.requestedRevision !== bookmarkRevision) this.build();
                if (this.resizePending) this.layout();
                else this.fitHeight();
            });
        }).catch(async error => {
            if (this.containers.get(container) !== state) return;
            state.busy = false;
            console.warn("Unable to open bookmark folder.", error);
            const previousId = state.currentId;
            if (this.pendingBoard) this.pendingBoard();
            if (this.requestedRevision !== bookmarkRevision) await this.build();
            if (this.containers.get(container) !== state) return;
            if (mode !== "push" && previousId === state.currentId && !state[mode].includes(folderId)) {
                this.updateContainer(container, null, mode);
            }
            if (this.resizePending) this.layout();
        });
        return true;
    },

    bindEvents() {
        this.element.addEventListener("mouseover", event => {
            const container = event.target.closest(".cont");
            if (container && !container.contains(event.relatedTarget)) this.activeContainer = container;
            const item = event.target.closest("li");
            if (!item || item.classList.contains("indicator") || item.contains(event.relatedTarget)) return;
            animate(item.parentElement.querySelector(".indicator"), {top: item.offsetTop}, 180);
        });
        this.element.addEventListener("mousedown", event => {
            const entry = event.target.closest(".bookmark-entry");
            if (event.button !== 1 || !entry) return;
            event.preventDefault();
            if (entry.dataset.linkType === "folder") {
                this.updateContainer(entry.closest(".cont"), entry.dataset.folderId, "push");
            }
        });
        for (const name of ["click", "auxclick"]) {
            this.element.addEventListener(name, event => {
                if (event.button !== (name === "click" ? 0 : 1)) return;
                const entry = event.target.closest(".bookmark-entry");
                const container = event.target.closest(".cont");
                if (entry) {
                    event.preventDefault();
                    if (entry.dataset.linkType === "folder") {
                        if (name === "click") this.updateContainer(container, entry.dataset.folderId, "push");
                        else event.stopPropagation();
                    } else {
                        event.stopPropagation();
                        openUrl(entry.getAttribute("href"), name === "auxclick");
                    }
                } else if (name === "click" && container) {
                    if (event.target.closest(".group_back")) this.navigate("back", container);
                    else if (event.target.closest(".group-actions")) {
                        for (const link of container.querySelector("ul").querySelectorAll("a")) {
                            if (link.protocol === "https:" || link.protocol === "http:") {
                                chrome.tabs.create({url: link.href}).catch(() => {});
                            }
                        }
                    }
                }
            });
        }
        let resizeTimer;
        window.addEventListener("resize", () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => this.layout(), 100);
        });
    }
};

const SearchModule = {
    revision: 0,
    query: "",

    init() {
        this.element = document.getElementById("bookmark-search-module");
        this.input = document.getElementById("searchInput");
        this.list = document.getElementById("searchSuggestions");
        this.bindEvents();
        this.setEnabled(localStorage.useBookmarksSearch !== "false");
    },

    setEnabled(enabled) {
        if (this.element.hidden === !enabled) return;
        this.element.hidden = !enabled;
        if (!enabled) {
            this.hide(true);
            this.input.blur();
        }
    },

    schedule(query, delay = 150) {
        if (this.element.hidden) return;
        query = query.trim();
        if (!query) return this.hide(true);
        if (query === this.query) return;
        clearTimeout(this.timer);
        this.query = query;
        delete this.list.dataset.query;
        const revision = ++this.revision;
        this.setActive(null);
        this.timer = setTimeout(async () => {
            if (this.element.hidden || importingBookmarks || document.activeElement !== this.input) return;
            try {
                const bookmarkVersion = this.bookmarkVersion = bookmarkRevision;
                const results = await chrome.bookmarks.search(query);
                if (revision !== this.revision || this.element.hidden || document.activeElement !== this.input) return;
                if (bookmarkVersion !== bookmarkRevision) return;
                this.render(query, results);
            } catch (error) {
                if (revision !== this.revision) return;
                this.hide(true);
                console.warn("Unable to search bookmarks.", error);
            }
        }, delay);
    },

    refresh() {
        if (!this.query || document.activeElement !== this.input || this.bookmarkVersion === bookmarkRevision) return;
        this.query = "";
        this.schedule(this.input.value, 0);
    },

    setActive(item) {
        const active = this.list.querySelector(".active");
        active?.classList.remove("active");
        active?.setAttribute("aria-selected", "false");
        if (item) {
            item.classList.add("active");
            item.setAttribute("aria-selected", "true");
            this.input.setAttribute("aria-activedescendant", item.id);
        } else this.input.removeAttribute("aria-activedescendant");
    },

    move(step) {
        const items = [...this.list.querySelectorAll("li:not(.dropdown-empty)")];
        const index = items.indexOf(this.list.querySelector(".active"));
        const next = items[index < 0 ? (step > 0 ? 0 : items.length - 1) : index + step];
        this.setActive(next);
        next?.scrollIntoView({block: "nearest"});
        this.keyboardScroll = this.list.scrollTop;
    },

    hasCurrentResults() {
        return !this.element.hidden && !importingBookmarks && this.bookmarkVersion === bookmarkRevision &&
            this.input.getAttribute("aria-expanded") === "true" && this.list.dataset.query === this.input.value.trim();
    },

    matchTitle(title, query) {
        const lower = title.toLowerCase();
        const start = lower.indexOf(query);
        if (start < 0) return null;
        const end = start + query.length;
        if (title.length === lower.length) return [start, end];

        // Lowercasing can expand one character into several UTF-16 units.
        let from = 0, offset = 0, folded = 0;
        for (const char of title) {
            if (folded <= start) from = offset;
            offset += char.length;
            folded += char.toLowerCase().length;
            if (folded >= end) return [from, offset];
        }
    },

    render(query, results) {
        const fragment = document.createDocumentFragment();
        const lower = query.toLowerCase();
        for (const match of results) {
            if (!match.url || !match.title) continue;
            const range = this.matchTitle(match.title, lower);
            if (!range) continue;
            const [start, end] = range;
            const item = document.createElement("li");
            item.id = `search-result-${fragment.childElementCount}`;
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", "false");
            const link = document.createElement("a");
            link.className = "dropdown-item";
            link.href = match.url;
            const icon = createFavicon(match.url);
            if (icon) link.append(icon);
            const title = document.createElement("span");
            const highlight = document.createElement("strong");
            highlight.textContent = match.title.slice(start, end);
            title.append(match.title.slice(0, start), highlight, match.title.slice(end));
            link.append(title);
            item.append(link);
            fragment.append(item);
            if (fragment.childElementCount === 10) break;
        }
        if (!fragment.childElementCount) {
            const empty = document.createElement("li");
            empty.className = "dropdown-empty";
            empty.setAttribute("role", "status");
            empty.textContent = i18n("search_suggestions_no_result");
            fragment.append(empty);
        }
        this.input.removeAttribute("aria-activedescendant");
        this.list.replaceChildren(fragment);
        this.list.scrollTop = 0;
        this.keyboardScroll = null;
        this.list.dataset.query = query;
        const visible = this.list.getClientRects().length > 0;
        stopAnimation(this.list, true);
        this.input.setAttribute("aria-expanded", "true");
        if (visible) Object.assign(this.list.style, {display: "block", opacity: "1", top: "33px"});
        else {
            Object.assign(this.list.style, {display: "block", opacity: "0", top: "29px"});
            animate(this.list, {opacity: 1, top: 33}, 140);
        }
    },

    hide(clear = false) {
        clearTimeout(this.timer);
        this.revision++;
        this.query = "";
        this.input.removeAttribute("aria-activedescendant");
        const open = this.input.getAttribute("aria-expanded") === "true";
        this.input.setAttribute("aria-expanded", "false");
        if (clear) this.list.replaceChildren();
        if (this.element.hidden) {
            stopAnimation(this.list);
            this.list.style.display = "none";
        } else if (open) {
            stopAnimation(this.list, true);
            animate(this.list, {opacity: 0, top: 29}, 110, () => { this.list.style.display = "none"; });
        }
    },

    bindEvents() {
        this.input.addEventListener("focus", () => {
            if (this.input.value) this.schedule(this.input.value, 0);
        });
        this.input.addEventListener("input", () => this.schedule(this.input.value));
        this.element.querySelector(".search-clear").addEventListener("click", () => {
            this.input.value = "";
            this.hide(true);
            this.input.focus();
        });
        this.input.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                this.hide();
                this.input.blur();
                event.preventDefault();
                return;
            }
            if (!this.hasCurrentResults()) return;
            if (["ArrowDown", "ArrowUp"].includes(event.key)) {
                event.preventDefault();
                this.move(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Enter") {
                const link = this.list.querySelector(".active a");
                if (!link) return;
                event.preventDefault();
                openUrl(link.getAttribute("href"));
                this.hide();
                this.input.blur();
            }
        });
        const hover = event => {
            // A keyboard scroll can fire mouseover under a stationary pointer.
            if (event.type === "mouseover" && this.keyboardScroll === this.list.scrollTop) return;
            this.keyboardScroll = null;
            const item = event.target.closest("li:not(.dropdown-empty)");
            if (item && !item.classList.contains("active") && this.hasCurrentResults()) this.setActive(item);
        };
        this.list.addEventListener("mouseover", hover);
        this.list.addEventListener("mousemove", hover);
        this.list.addEventListener("mousedown", event => {
            if (event.button <= 1 && event.target.closest("a")) event.preventDefault();
        });
        for (const name of ["click", "auxclick"]) {
            this.list.addEventListener(name, event => {
                const link = event.target.closest("a");
                if (!link || event.button !== (name === "click" ? 0 : 1)) return;
                event.preventDefault();
                if (!this.hasCurrentResults()) return;
                openUrl(link.getAttribute("href"), name === "auxclick");
                if (name === "click") {
                    this.hide();
                    this.input.blur();
                }
            });
            this.element.addEventListener(name, event => event.stopPropagation());
        }
        this.element.addEventListener("mousedown", event => {
            event.stopPropagation();
            OptionsModule.close();
        });
        this.element.addEventListener("focusout", event => {
            if (!this.element.contains(event.relatedTarget)) this.hide();
        });
        document.addEventListener("mousedown", () => {
            if (this.element.hidden) return;
            this.hide();
            this.input.blur();
        });
    }
};

const OptionsModule = {
    init() {
        this.element = document.getElementById("options-module");
        this.button = document.getElementById("options_button");
        this.controls = {};
        for (const input of this.element.querySelectorAll("input")) this.controls[input.id] = input;
        this.loadControls();
        this.bindEvents();
    },

    loadControls() {
        const controls = this.controls;
        controls.allowBookmarksSearch.checked = localStorage.useBookmarksSearch !== "false";
        controls.faviconDisplayed.checked = localStorage.faviconDisplayed !== "0";
        controls.newTab.checked = localStorage.target === "_blank";
        controls.currentTab.checked = !controls.newTab.checked;
    },

    close() {
        this.button.setAttribute("aria-expanded", "false");
        if (this.element.getClientRects().length) {
            stopAnimation(this.element, true);
            animate(this.element, {opacity: 0, top: 40}, 110, () => {
                this.element.style.display = "none";
            });
        }
        document.removeEventListener("click", this.outsideClick);
    },

    open() {
        this.loadControls();
        this.button.setAttribute("aria-expanded", "true");
        stopAnimation(this.element, true);
        Object.assign(this.element.style, {display: "block", opacity: "0", top: "40px"});
        animate(this.element, {opacity: 1, top: 48}, 140);
        document.addEventListener("click", this.outsideClick);
    },

    bindEvents() {
        const controls = this.controls;
        window.addEventListener("storage", ({key, storageArea}) => {
            if (storageArea !== localStorage) return;
            if (key !== null && !["useBookmarksSearch", "faviconDisplayed", "target"].includes(key)) return;
            this.loadControls();
            SearchModule.setEnabled(controls.allowBookmarksSearch.checked);
            if (key === null || key === "faviconDisplayed") BookmarksModule.refreshIcons();
        });
        this.outsideClick = () => this.close();
        this.button.addEventListener("click", event => {
            event.stopPropagation();
            if (this.element.getClientRects().length) this.close();
            else this.open();
        });
        for (const name of ["click", "mousedown", "auxclick"]) {
            this.element.addEventListener(name, event => event.stopPropagation());
        }
        this.element.addEventListener("change", event => {
            if (event.target === controls.allowBookmarksSearch) {
                localStorage.useBookmarksSearch = String(event.target.checked);
                SearchModule.setEnabled(event.target.checked);
            } else if (event.target === controls.faviconDisplayed) {
                localStorage.faviconDisplayed = event.target.checked ? "1" : "0";
                BookmarksModule.refreshIcons();
            } else if (event.target.name === "tabOption") {
                localStorage.target = controls.newTab.checked ? "_blank" : "_self";
            }
        });
    }
};

function bindHistory() {
    const editable = target => target.closest?.("input, textarea, select, [contenteditable=true]");
    document.addEventListener("keydown", event => {
        if (editable(event.target)) return;
        const back = event.key === "Backspace" || (event.altKey && event.key === "ArrowLeft");
        const forward = event.altKey && event.key === "ArrowRight";
        if (back && BookmarksModule.navigate("back")) event.preventDefault();
        else if (forward && BookmarksModule.navigate("forward")) event.preventDefault();
    });
    let handledButton = null;
    document.addEventListener("mousedown", event => {
        handledButton = null;
        if (editable(event.target) || ![3, 4].includes(event.button)) return;
        if (BookmarksModule.navigate(event.button === 3 ? "back" : "forward")) {
            handledButton = event.button;
            event.preventDefault();
            event.stopPropagation();
        }
    });
    for (const name of ["mouseup", "auxclick"]) {
        document.addEventListener(name, event => {
            if (event.button !== handledButton) return;
            event.preventDefault();
            event.stopPropagation();
            if (name === "auxclick") handledButton = null;
        });
    }
}

function init() {
    const language = chrome.i18n.getUILanguage().split(/[-_]/, 1)[0];
    document.documentElement.lang = ["de", "en", "fr", "it", "ru", "uk"].includes(language) ? language : "en";
    document.title = i18n("appName");
    for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = i18n(element.dataset.i18n);
    for (const element of document.querySelectorAll("[data-i18n-placeholder]")) {
        element.placeholder = i18n(element.dataset.i18nPlaceholder);
    }
    for (const element of document.querySelectorAll("[data-i18n-aria]")) {
        element.setAttribute("aria-label", i18n(element.dataset.i18nAria));
    }
    BookmarksModule.element = document.getElementById("bookmarks-module");
    OptionsModule.init();
    SearchModule.init();
    BookmarksModule.bindEvents();
    bindHistory();
    let frame = 0;
    refreshBookmarks = () => {
        if (frame || document.hidden || importingBookmarks) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            if (document.hidden || importingBookmarks) return;
            SearchModule.refresh();
            if (BookmarksModule.requestedRevision !== bookmarkRevision) BookmarksModule.build();
        });
    };
    document.addEventListener("visibilitychange", refreshBookmarks);
    if (!initialTreeReady && initialBookmarkRevision === bookmarkRevision) BookmarksModule.restore();
    BookmarksModule.build(initialBookmarks, initialBookmarkRevision);
    initialBookmarks = null;
}

init();
