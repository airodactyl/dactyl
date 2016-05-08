// Copyright (c) 2006-2008 by Martin Stubenschrott <stubenschrott@vimperator.org>
// Copyright (c) 2007-2011 by Doug Kearns <dougkearns@gmail.com>
// Copyright (c) 2008-2015 Kris Maglione <maglione.k at Gmail>
//
// This work is licensed for reuse under an MIT license. Details are
// given in the LICENSE.txt file included with this file.
"use strict";

/** @scope modules */

// TODO: many methods do not work with Thunderbird correctly yet

/**
 * @instance tabs
 */
var Tabs = Module("tabs", {
    init: function () {
        // used for the "gb" and "gB" mappings to remember the last :buffer[!] command
        this._lastBufferSwitchArgs = "";
        this._lastBufferSwitchSpecial = true;

        this.xulTabs = document.getElementById("tabbrowser-tabs");

        // hide tabs initially to prevent flickering when 'stal' would hide them
        // on startup
        if (config.has("tabbrowser"))
            config.tabStrip.collapsed = true;

        this.tabStyle = styles.system.add("tab-strip-hiding", config.styleableChrome,
                                          (config.tabStrip.id ? "#" + config.tabStrip.id
                                                              : ".tabbrowser-strip") +
                                              "{ visibility: collapse; }",
                                          false, true);

        dactyl.commands["tabs.select"] = event => {
            tabs.switchTo(event.originalTarget.getAttribute("identifier"));
        };

        this.tabBinding = styles.system.add(
            "tab-binding", "chrome://browser/content/browser.xul",
            String.raw`
                xul|tab { -moz-binding: url(chrome://dactyl/content/bindings.xml#tab) !important; }
            `,
            false, true);

        this.timeout(function () {
            for (let { linkedBrowser: { contentDocument } } of this.allTabs)
                if (contentDocument.readyState === "complete")
                    dactyl.initDocument(contentDocument);
        }, 1000);

        if (window.TabsInTitlebar)
            window.TabsInTitlebar.allowedBy("dactyl", false);
    },

    signals: {
        enter: function enter() {
            if (window.TabsInTitlebar)
                window.TabsInTitlebar.allowedBy("dactyl", true);
        }
    },

    _alternates: Class.Memoize(() => [gBrowser.mCurrentTab, null]),

    cleanup: function cleanup() {
        for (let tab of this.allTabs) {
            let node = function node(class_) {
                return document.getAnonymousElementByAttribute(tab, "class", class_);
            };
            for (let elem of ["dactyl-tab-icon-number", "dactyl-tab-number"].map(node))
                if (elem)
                    elem.parentNode.parentNode.removeChild(elem.parentNode);

            delete tab.dactylOrdinal;
            tab.removeAttribute("dactylOrdinal");
        }
    },

    updateTabCount: function updateTabCount() {
        for (let [i, tab] of iter(this.visibleTabs)) {
            let node = function node(class_) {
                return document.getAnonymousElementByAttribute(tab, "class", class_);
            };
            if (!node("dactyl-tab-number")) {
                let img = node("tab-icon-image");
                if (img) {
                    let dom = DOM([
                        ["xul:hbox", { highlight: "tab-number" },
                            ["xul:label", { key: "icon", align: "center", highlight: "TabIconNumber",
                                            class: "dactyl-tab-icon-number" }]],
                        ["xul:hbox", { highlight: "tab-number" },
                            ["html:div", { key: "label", highlight: "TabNumber",
                                           class: "dactyl-tab-number" }]]],
                        document).appendTo(img.parentNode);

                    update(tab, {
                        get dactylOrdinal() {
                            return Number(dom.nodes.icon.value);
                        },
                        set dactylOrdinal(i) {
                            dom.nodes.icon.value = dom.nodes.label.textContent = i;
                            this.setAttribute("dactylOrdinal", i);
                        }
                    });
                }
            }
            tab.dactylOrdinal = i + 1;
        }
        statusline.updateTabCount(true);
    },

    _onTabSelect: function _onTabSelect() {
        // TODO: is all of that necessary?
        //       I vote no. --Kris
        modes.reset();
        statusline.updateTabCount(true);
        this.updateSelectionHistory();
    },

    get allTabs() {
        return Array.slice(gBrowser.tabs);
    },

    /**
     * @property {Object} The previously accessed tab or null if no tab
     *     other than the current one has been accessed.
     */
    get alternate() {
        let alt = this._alternates[1];
        return this.allTabs.indexOf(alt) > -1 ? alt : null;
    },

    /**
     * @property {Iterator(Object)} A genenerator that returns all browsers
     *     in the current window.
     */
    get browsers() {
        return function* () {
            for (let [i, browser] of gBrowser.browsers.entries())
                if (browser !== undefined) // Bug in Google's Page Speed add-on.
                    yield [i, browser];
        }();
    },

    /**
     * @property {number} The number of tabs in the current window.
     */
    get count() { return gBrowser.mTabs.length; },

    /**
     * @property {Object} The local options store for the current tab.
     */
    get options() { return this.localStore.options; },

    get visibleTabs() {
        return gBrowser.visibleTabs ||
               this.allTabs.filter(tab => !tab.hidden);
    },

    /**
     * Returns the local state store for the tab at the specified *tabIndex*.
     * If *tabIndex* is not specified then the current tab is used.
     *
     * @param {number} tabIndex
     * @returns {Object}
     */
    // FIXME: why not a tab arg? Why this and the property?
    //      : To the latter question, because this works for any tab, the
    //        property doesn't. And the property is so oft-used that it's
    //        convenient. To the former question, because I think this is mainly
    //        useful for autocommands, and they get index arguments. --Kris
    getLocalStore: function getLocalStore(tabIndex) {
        let tab = this.getTab(tabIndex);
        if (!tab.dactylStore)
            tab.dactylStore = Object.create(this.localStorePrototype);
        return tab.dactylStore.instance = tab.dactylStore;
    },

    /**
     * @property {Object} The local state store for the currently selected
     *     tab.
     */
    get localStore() { return this.getLocalStore(); },

    localStorePrototype: memoize({
        instance: {},
        get options() { return {}; }
    }),

    /**
     * @property {[Object]} The array of closed tabs for the current
     *     session.
     */
    get closedTabs() {
        return JSON.parse(services.sessionStore.getClosedTabData(window));
    },

    /**
     * Clones the specified *tab* and append it to the tab list.
     *
     * @param {Object} tab The tab to clone.
     * @param {boolean} activate Whether to select the newly cloned tab.
     */
    cloneTab: function cloneTab(tab, activate) {
        let newTab = gBrowser.addTab("about:blank", { ownerTab: tab });
        Tabs.copyTab(newTab, tab);

        if (activate)
            gBrowser.mTabContainer.selectedItem = newTab;

        return newTab;
    },

    /**
     * Detaches the specified *tab* and open it in a new window. If no tab is
     * specified the currently selected tab is detached.
     *
     * @param {Object} tab The tab to detach.
     */
    detachTab: function detachTab(tab) {
        if (!tab)
            tab = gBrowser.mTabContainer.selectedItem;

        services.windowWatcher
                .openWindow(window, window.getBrowserURL(), null, "chrome,dialog=no,all", tab);
    },

    /**
     * Returns the index of the tab containing *content*.
     *
     * @param {Object} content Either a content window or a content
     *     document.
     */
    // FIXME: Only called once...necessary?
    getContentIndex: function getContentIndex(content) {
        for (let [i, browser] of this.browsers) {
            if (browser.contentWindow == content || browser.contentDocument == content)
                return i;
        }
        return -1;
    },

    /**
     * If TabView exists, returns the Panorama window. If the Panorama
     * is has not yet initialized, this function will not return until
     * it has.
     *
     * @returns {Window}
     */
    getGroups: function getGroups(func) {
        let iframe = document.getElementById("tab-view");
        this._groups = iframe ? iframe.contentWindow : null;

        if (this._groups && !func)
            return this._groups;

        if (window.TabView && window.TabView._initFrame)
            window.TabView._initFrame(bind(function (f) { this._groups = document.getElementById("tab-view").contentWindow; f(this._groups); }, this, func ? func : () => null));

        if (!this._groups && !func)
            util.waitFor(() => tabs._groups != null && "GroupItems" in tabs._groups && tabs._groups.GroupItems != null);

        return this._groups;
    },

    /**
     * Returns the tab at the specified *index* or the currently selected tab
     * if *index* is not specified. This is a 0-based index.
     *
     * @param {number|Node} index The index of the tab required or the tab itself
     * @param {boolean} visible If true, consider only visible tabs rather than
     *      all tabs.
     * @returns {Object}
     */
    getTab: function getTab(index, visible) {
        if (index instanceof Node)
            return index;
        if (index != null)
            return this[visible ? "visibleTabs" : "allTabs"][index];
        return gBrowser.mCurrentTab;
    },

    /**
     * Returns the index of *tab* or the index of the currently selected tab if
     * *tab* is not specified. This is a 0-based index.
     *
     * @param {<xul:tab/>} tab A tab from the current tab list.
     * @param {boolean} visible Whether to consider only visible tabs.
     * @returns {number}
     */
    index: function index(tab, visible) {
        let tabs = this[visible ? "visibleTabs" : "allTabs"];
        return tabs.indexOf(tab || gBrowser.mCurrentTab);
    },

    /**
     * @param spec can either be:
     * - an absolute integer
     * - "" for the current tab
     * - "+1" for the next tab
     * - "-3" for the tab, which is 3 positions left of the current
     * - "$" for the last tab
     */
    indexFromSpec: function indexFromSpec(spec, wrap, offset) {
        if (spec instanceof Node)
            return this.allTabs.indexOf(spec);

        let tabs     = this.visibleTabs;
        let position = this.index(null, true);

        if (spec == null)
            return -1;

        if (spec === "")
            return position;

        if (/^\d+$/.test(spec))
            position = parseInt(spec, 10) + (offset || 0);
        else if (spec === "$")
            position = tabs.length - 1;
        else if (/^[+-]\d+$/.test(spec))
            position += parseInt(spec, 10);
        else
            return -1;

        if (position >= tabs.length)
            position = wrap ? position % tabs.length : tabs.length - 1;
        else if (position < 0)
            position = wrap ? (position % tabs.length) + tabs.length : 0;

        return this.allTabs.indexOf(tabs[position]);
    },

    /**
     * Removes all tabs from the tab list except the specified *tab*.
     *
     * @param {Object} tab The tab to keep.
     */
    keepOnly: function keepOnly(tab) {
        gBrowser.removeAllTabsBut(tab);
    },

    /**
     * Lists all tabs matching *filter*.
     *
     * @param {string} filter A filter matching a substring of the tab's
     *     document title or URL.
     */
    list: function list(filter) {
        completion.listCompleter("buffer", filter);
    },

    /**
     * Return an iterator of tabs matching the given filter. If no
     * *filter* or *count* is provided, returns the currently selected
     * tab. If *filter* is a number or begins with a number followed
     * by a colon, the tab of that ordinal is returned. Otherwise,
     * tabs matching the filter as below are returned.
     *
     * @param {string} filter The filter. If *regexp*, this is a
     *      regular expression against which the tab's URL or title
     *      must match. Otherwise, it is a site filter.
     *      @optional
     * @param {number|null} count If non-null, return only the
     *      *count*th matching tab.
     *      @optional
     * @param {boolean} regexp Whether to interpret *filter* as a
     *      regular expression.
     * @param {boolean} all If true, match against all tabs. If
     *      false, match only tabs in the current tab group.
     */
    match: function* match(filter, count, regexp, all) {
        if (!filter && count == null)
            yield tabs.getTab();
        else if (!filter)
            yield dactyl.assert(tabs.getTab(count - 1));
        else {
            let matches = /^(\d+)(?:$|:)/.exec(filter);
            if (matches)
                yield dactyl.assert(count == null &&
                                    tabs.getTab(parseInt(matches[1], 10) - 1, !all));
            else {
                if (regexp)
                    regexp = util.regexp(filter, "i");
                else
                    var matcher = Styles.matchFilter(filter);

                for (let tab of tabs[all ? "allTabs" : "visibleTabs"]) {
                    let browser = tab.linkedBrowser;
                    let uri = browser.currentURI;
                    let title;
                    if (uri.spec == "about:blank")
                        title = "(Untitled)";
                    else
                        title = browser.contentTitle;

                    if (matcher && matcher(uri)
                        || regexp && (regexp.test(title) || regexp.test(uri.spec)))
                        if (count == null || --count == 0)
                            yield tab;
                }
            }
        }
    },

    /**
     * Moves a tab to a new position in the tab list.
     *
     * @param {Object} tab The tab to move.
     * @param {string} spec See {@link Tabs.indexFromSpec}.
     * @param {boolean} wrap Whether an out of bounds *spec* causes the
     *     destination position to wrap around the start/end of the tab list.
     */
    move: function move(tab, spec, wrap) {
        let index = tabs.indexFromSpec(spec, wrap, -1);
        gBrowser.moveTabTo(tab, index);
    },

    /**
     * Removes the specified *tab* from the tab list.
     *
     * @param {Object} tab The tab to remove.
     * @param {number} count How many tabs to remove.
     * @param {boolean} focusLeftTab Focus the tab to the left of the removed tab.
     */
    remove: function remove(tab, count=1, focusLeftTab=false) {
        let res = this.count > count;

        let tabs = this.visibleTabs;
        if (tabs.indexOf(tab) < 0)
            tabs = this.allTabs;
        let index = tabs.indexOf(tab);

        let next = index + (focusLeftTab ? -count : count);
        if (!(next in tabs))
            next = index + (focusLeftTab ? 1 : -1);
        if (next in tabs) {
            this._alternates[0] = tabs[next];
            gBrowser.mTabContainer.selectedItem = tabs[next];
        }

        if (focusLeftTab)
            tabs.slice(Math.max(0, index + 1 - count),
                       index + 1)
                .forEach(config.bound.removeTab);
        else
            tabs.slice(index,
                       index + count)
                .forEach(config.bound.removeTab);
        return res;
    },

    /**
     * Reloads the specified tab.
     *
     * @param {Object} tab The tab to reload.
     * @param {boolean} bypassCache Whether to bypass the cache when
     *     reloading.
     */
    reload: function reload(tab, bypassCache) {
        try {
            if (bypassCache) {
                const flags = Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY | Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE;
                gBrowser.getBrowserForTab(tab).reloadWithFlags(flags);
            }
            else
                gBrowser.reloadTab(tab);
        }
        catch (e if !(e instanceof Error)) {}
    },

    /**
     * Reloads all tabs.
     *
     * @param {boolean} bypassCache Whether to bypass the cache when
     *     reloading.
     */
    reloadAll: function reloadAll(bypassCache) {
        this.visibleTabs.forEach(function (tab) {
            try {
                tabs.reload(tab, bypassCache);
            }
            catch (e) {
                dactyl.reportError(e, true);
            }
        });
    },

    /**
     * Selects the tab at the position specified by *spec*.
     *
     * @param {string} spec See {@link Tabs.indexFromSpec}
     * @param {boolean} wrap Whether an out of bounds *spec* causes the
     *     selection position to wrap around the start/end of the tab list.
     */
    select: function select(spec, wrap) {
        let index = tabs.indexFromSpec(spec, wrap);
        if (index == -1)
            dactyl.beep();
        else
            gBrowser.mTabContainer.selectedIndex = index;
    },

    /**
     * Selects the alternate tab.
     */
    selectAlternateTab: function selectAlternateTab() {
        dactyl.assert(tabs.alternate != null && tabs.getTab() != tabs.alternate,
                      _("buffer.noAlternate"));
        tabs.select(tabs.alternate);
    },

    /**
     * Stops loading the specified tab.
     *
     * @param {Object} tab The tab to stop loading.
     */
    stop: function stop(tab) {
        if (config.stop)
            config.stop(tab);
        else
            tab.linkedBrowser.stop();
    },

    /**
     * Stops loading all tabs.
     */
    stopAll: function stopAll() {
        for (let [, browser] of this.browsers)
            browser.stop();
    },

    /**
     * Selects the tab containing the specified *buffer*.
     *
     * @param {string} buffer A string which matches the URL or title of a
     *     buffer, if it is null, the last used string is used again.
     * @param {boolean} allowNonUnique Whether to select the first of
     *     multiple matches.
     * @param {number} count If there are multiple matches select the
     *     *count*th match.
     * @param {boolean} reverse Whether to search the buffer list in
     *     reverse order.
     *
     */
    // FIXME: help!
    switchTo: function switchTo(buffer, allowNonUnique, count, reverse) {
        if (buffer != null) {
            // store this command, so it can be repeated with "B"
            this._lastBufferSwitchArgs = buffer;
            this._lastBufferSwitchSpecial = allowNonUnique;
        }
        else {
            buffer = this._lastBufferSwitchArgs;
            if (allowNonUnique == null) // XXX
                allowNonUnique = this._lastBufferSwitchSpecial;
        }

        if (buffer == "#")
            return tabs.selectAlternateTab();

        reverse = Boolean(reverse);
        count = Math.max(1, count || 1) * (1 + -2 * reverse);

        let matches = buffer.match(/^(\d+):?/);
        if (matches)
            return tabs.select(this.allTabs[parseInt(matches[1], 10) - 1], false);

        matches = tabs.allTabs.find(t => (t.linkedBrowser.lastURI || {}).spec === buffer);
        if (matches)
            return tabs.select(matches, false);

        matches = completion.runCompleter("buffer", buffer).map(obj => obj.tab);

        if (matches.length == 0)
            dactyl.echoerr(_("buffer.noMatching", buffer));
        else if (matches.length > 1 && !allowNonUnique)
            dactyl.echoerr(_("buffer.multipleMatching", buffer));
        else {
            let start = matches.indexOf(tabs.getTab());
            if (start == -1 && reverse)
                start++;

            let index = (start + count) % matches.length;
            if (index < 0)
                index = matches.length + index;
            tabs.select(matches[index], false);
        }
    },

    // NOTE: when restarting a session FF selects the first tab and then the
    // tab that was selected when the session was created.  As a result the
    // alternate after a restart is often incorrectly tab 1 when there
    // shouldn't be one yet.
    /**
     * Sets the current and alternate tabs, updating the tab selection
     * history.
     *
     * @param {Array(Object)} tabs The current and alternate tab.
     * @see tabs#alternate
     */
    updateSelectionHistory: function updateSelectionHistory(tabs) {
        if (!tabs) {
            if (this.getTab() == this._alternates[0]
                || this.alternate && this.allTabs.indexOf(this._alternates[0]) == -1
                || this.alternate && gBrowser._removingTabs && gBrowser._removingTabs.indexOf(this._alternates[0]) >= 0)
                tabs = [this.getTab(), this.alternate];
        }
        this._alternates = tabs || [this.getTab(), this._alternates[0]];
    }
}, {
    copyTab: function (to, from) {
        if (!from)
            from = gBrowser.mTabContainer.selectedItem;

        let tabState = services.sessionStore.getTabState(from);
        services.sessionStore.setTabState(to, tabState);
    }
}, {
    load: function initLoad() {
        tabs.updateTabCount();
    },
    commands: function initCommands() {
        [
            {
                name: ["bd[elete]"],
                description: "Delete matching buffers",
                visible: false
            },
            {
                name: ["tabc[lose]"],
                description: "Delete matching tabs",
                visible: true
            }
        ].forEach(function (params) {
            commands.add(params.name, params.description,
                function (args) {
                    let removed = 0;
                    for (let tab of tabs.match(args[0], args.count, args.bang, !params.visible)) {
                        config.removeTab(tab);
                        removed++;
                    }

                    if (args[0])
                        if (removed > 0)
                            dactyl.echomsg(_("buffer.fewerTab" + (removed == 1 ? "" : "s"), removed), 9);
                        else
                            dactyl.echoerr(_("buffer.noMatching", args[0]));
                }, {
                    argCount: "?",
                    bang: true,
                    count: true,
                    completer: function (context) {
                        completion.buffer(context);
                    },
                    literal: 0,
                    privateData: true
                });
        });

        commands.add(["pin[tab]"],
            "Pin tab as an application tab",
            function (args) {
                for (let tab of tabs.match(args[0], args.count))
                    config.browser[!args.bang || !tab.pinned ? "pinTab" : "unpinTab"](tab);
            }, {
                argCount: "?",
                bang: true,
                count: true,
                completer: function (context, args) {
                    if (!args.bang)
                        context.filters.push(({ item }) => !item.tab.pinned);
                    completion.buffer(context);
                }
            });

        commands.add(["unpin[tab]"],
            "Unpin tab as an application tab",
            function (args) {
                for (let tab of tabs.match(args[0], args.count))
                    config.browser.unpinTab(tab);
            }, {
                argCount: "?",
                count: true,
                completer: function (context) {
                    context.filters.push(({ item }) => item.tab.pinned);
                    completion.buffer(context);
                }
            });

        commands.add(["keepa[lt]"],
            "Execute a command without changing the current alternate buffer",
            function (args) {
                try {
                    dactyl.execute(args[0], null, true);
                }
                finally {
                    tabs.updateSelectionHistory([tabs.getTab(), tabs.alternate]);
                }
            }, {
                argCount: "1",
                completer: function (context) { completion.ex(context); },
                literal: 0,
                subCommand: 0
            });

        commands.add(["tab"],
            "Execute a command and tell it to output in a new tab",
            function (args) {
                dactyl.withSavedValues(["forceTarget"], function () {
                    this.forceTarget = dactyl.NEW_TAB;
                    dactyl.execute(args[0], null, true);
                });
            }, {
                argCount: "1",
                completer: function (context) { completion.ex(context); },
                literal: 0,
                subCommand: 0
            });

        commands.add(["background", "bg"],
            "Execute a command opening any new tabs in the background",
            function (args) {
                dactyl.withSavedValues(["forceBackground"], function () {
                    this.forceBackground = true;
                    dactyl.execute(args[0], null, true);
                });
            }, {
                argCount: "1",
                completer: function (context) { completion.ex(context); },
                literal: 0,
                subCommand: 0
            });

        commands.add(["tabd[o]", "bufd[o]"],
            "Execute a command in each tab",
            function (args) {
                for (let tab of tabs.visibleTabs) {
                    tabs.select(tab);
                    dactyl.execute(args[0], null, true);
                }
            }, {
                argCount: "1",
                completer: function (context) { completion.ex(context); },
                literal: 0,
                subCommand: 0
            });

        commands.add(["tabl[ast]", "bl[ast]"],
            "Switch to the last tab",
            function () { tabs.select("$", false); },
            { argCount: "0" });

        // TODO: "Zero count" if 0 specified as arg
        commands.add(["tabp[revious]", "tp[revious]", "tabN[ext]", "tN[ext]", "bp[revious]", "bN[ext]"],
            "Switch to the previous tab or go [count] tabs back",
            function (args) {
                let count = args.count;
                let arg   = args[0];

                // count is ignored if an arg is specified, as per Vim
                if (arg) {
                    if (/^\d+$/.test(arg))
                        tabs.select("-" + arg, true);
                    else
                        dactyl.echoerr(_("error.trailingCharacters"));
                }
                else if (count > 0)
                    tabs.select("-" + count, true);
                else
                    tabs.select("-1", true);
            }, {
                argCount: "?",
                count: true
            });

        // TODO: "Zero count" if 0 specified as arg
        commands.add(["tabn[ext]", "tn[ext]", "bn[ext]"],
            "Switch to the next or [count]th tab",
            function (args) {
                let count = args.count;
                let arg   = args[0];

                if (arg || count > 0) {
                    let index;

                    // count is ignored if an arg is specified, as per Vim
                    if (arg) {
                        dactyl.assert(/^\d+$/.test(arg), _("error.trailingCharacters"));
                        index = arg - 1;
                    }
                    else
                        index = count - 1;

                    if (index < tabs.count)
                        tabs.select(index, true);
                    else
                        dactyl.beep();
                }
                else
                    tabs.select("+1", true);
            }, {
                argCount: "?",
                count: true
            });

        commands.add(["tabr[ewind]", "tabfir[st]", "br[ewind]", "bf[irst]"],
            "Switch to the first tab",
            function () { tabs.select(0, false); },
            { argCount: "0" });

        if (config.has("tabbrowser")) {
            commands.add(["b[uffer]"],
                "Switch tabs in all tab groups",
                function (args) {
                    // pinned first
                    let allTabs = tabs.visibleTabs.filter((item) => item.pinned);

                    // add tabs by tabgroup order
                    for (let group of tabs.getGroups().GroupItems.groupItems) {
                        for (let child of group.getChildren()) {
                            allTabs.push(child.tab);
                        }
                    }

                    if (args.length) {
                        let tokens = args[0].split(' ');
                        let found = tokens[0].match(/^([1-9]\d*):?$/);

                        if (tokens.length == 1 && found && parseInt(found[1]) <= tabs.allTabs.length)
                            tabs.select(allTabs[parseInt(found[1]) - 1]);
                        else {
                            let dict = {};

                            for (let i = 0; i < allTabs.length; i++) {
                                dict[i] = [i+1 + ": " + (allTabs[i].label || "(Untitled)"), i+1 + ": " + allTabs[i].linkedBrowser.contentDocument.location.href];
                            }

                            let result = util.substringSearch(args[0], dict);

                            if (result)
                                tabs.select(allTabs[result]);
                        }
                    }
                }, {
                    argCount: "?",
                    bang: true,
                    count: true,
                    completer: function (context) {
                        completion.buffer(context);
                    },
                    literal: 0,
                    privateData: true
                });

            commands.add(["cur[rent]"],
                "Switch tabs in current tab group",
                function (args) {
                    if (args.length) {
                        let tokens = args[0].split(' ');
                        let found = tokens[0].match(/^([1-9]\d*):?$/);

                        if (tokens.length == 1 && found && parseInt(found[1]) <= tabs.visibleTabs.length)
                            tabs.select(tabs.visibleTabs[parseInt(found[1]) - 1]);
                        else {
                            let dict = {};

                            for (let i = 0; i < tabs.visibleTabs.length; i++) {
                                dict[i] = [i+1 + ": " + (tabs.visibleTabs[i].label || "(Untitled)"), i+1 + ": " + tabs.visibleTabs[i].linkedBrowser.contentDocument.location.href];
                            }

                            let result = util.substringSearch(args[0], dict);

                            if (result)
                                tabs.select(tabs.visibleTabs[result]);
                        }

                    }
                }, {
                    argCount: "?",
                    bang: true,
                    count: true,
                    completer: function (context) {
                        completion.buffer(context, true);
                    },
                    literal: 0,
                    privateData: true
                });

            commands.add(["tabg[roup]"],
                "Switch tab groups",
                function (args) {
                    if (args.length) {
                        let tokens = args[0].split(' ');
                        let found = tokens[0].match(/^([1-9]\d*):?$/);
                        let groups = tabs.getGroups().GroupItems.groupItems;

                        if (tokens.length == 1 && found && parseInt(found[1]) <= groups.length)
                            tabs.select(groups[parseInt(found[1]) - 1].getActiveTab().tab);
                        else {
                            let dict = {};

                            for (let i = 0; i < groups.length; i++) {
                                dict[i] = [i+1 + ": " + (groups[i].getTitle() || "(Untitled)")]; 
                            }

                            let result = util.substringSearch(args[0], dict);

                            if (result)
                                tabs.select(groups[result].getActiveTab().tab);
                        }
                    }
                }, {
                    argCount: "?",
                    bang: true,
                    count: true,
                    completer: function (context) {
                        completion.tabGroup(context);
                    },
                    literal: 0,
                    privateData: true
                });

            commands.add(["buffers", "files", "ls", "tabs"],
                "Show a list of all buffers",
                function (args) { tabs.list(args[0] || ""); }, {
                    argCount: "?",
                    literal: 0
                });

            commands.add(["quita[ll]", "qa[ll]"],
                "Quit this " + config.appName + " window",
                function () { window.close(); },
                { argCount: "0" });

            commands.add(["reloada[ll]"],
                "Reload all tab pages",
                function (args) { tabs.reloadAll(args.bang); }, {
                    argCount: "0",
                    bang: true
                });

            commands.add(["stopa[ll]"],
                "Stop loading all tab pages",
                function () { tabs.stopAll(); },
                { argCount: "0" });

            // TODO: add count and bang multimatch support - unify with :buffer nonsense
            commands.add(["tabm[ove]"],
                "Move the current tab to the position of tab N",
                function (args) {
                    let arg = args[0];

                    if (tabs.indexFromSpec(arg) == -1) {
                        let list = Array.from(tabs.match(args[0], args.count, true));

                        dactyl.assert(list.length, _("error.invalidArgument", arg));
                        dactyl.assert(list.length == 1, _("buffer.multipleMatching", arg));
                        arg = list[0];
                    }
                    tabs.move(tabs.getTab(), arg, args.bang);
                }, {
                    argCount: "1",
                    bang: true,
                    completer: function (context) {
                        completion.buffer(context, true);
                    },
                    literal: 0
                });

            commands.add(["tabo[nly]"],
                "Close all other tabs",
                function () { tabs.keepOnly(tabs.getTab()); },
                { argCount: "0" });

            commands.add(["tabopen", "t[open]", "tabnew"],
                "Open one or more URLs in a new tab",
                function (args) {
                    dactyl.open(args[0] || "about:blank",
                                { from: "tabopen", where: dactyl.NEW_TAB, background: args.bang });
                }, {
                    bang: true,
                    completer: function (context) {
                        completion.url(context);
                    },
                    domains: function (args) {
                        return commands.get("open").domains(args);
                    },
                    literal: 0,
                    privateData: true
                });

            commands.add(["tabde[tach]"],
                "Detach current tab to its own window",
                function () { tabs.detachTab(null); },
                { argCount: "0" });

            commands.add(["tabdu[plicate]"],
                "Duplicate current tab",
                function (args) {
                    let tab = tabs.getTab();

                    let activate = args.bang ? true : false;
                    if (options.get("activate").has("tabopen"))
                        activate = !activate;

                    for (let i of util.range(0, Math.max(1, args.count)))
                        tabs.cloneTab(tab, activate);
                }, {
                    argCount: "0",
                    bang: true,
                    count: true
                });

            // TODO: match window by title too?
            //     : accept the full :tabmove arg spec for the tab index arg?
            //     : better name or merge with :tabmove?
            commands.add(["taba[ttach]"],
                "Attach the current tab to another window",
                function (args) {
                    dactyl.assert(args.length <= 2 && !args.some(i => !/^\d+(?:$|:)/.test(i)),
                                  _("error.trailingCharacters"));

                    let [winIndex, tabIndex] = args.map(arg => parseInt(arg));
                    if (args["-group"]) {
                        util.assert(args.length == 1);
                        window.TabView.moveTabTo(tabs.getTab(), winIndex);
                        return;
                    }

                    let win = dactyl.windows[winIndex - 1];
                    let sourceTab = tabs.getTab();

                    dactyl.assert(win, _("window.noIndex", winIndex));
                    dactyl.assert(win != window, _("window.cantAttachSame"));

                    let modules     = win.dactyl.modules;
                    let { browser } = modules.config;

                    let newTab = browser.addTab("about:blank");
                    browser.stop();
                    // XXX: the implementation of DnD in tabbrowser.xml suggests
                    // that we may not be guaranteed of having a docshell here
                    // without this reference?
                    browser.docShell;

                    if (args[1]) {
                        let { visibleTabs, allTabs } = modules.tabs;
                        tabIndex = Math.constrain(tabIndex, 1, visibleTabs.length);
                        let target = visibleTabs[tabIndex - 1];
                        browser.moveTabTo(newTab, Array.indexOf(allTabs, target));
                    }

                    browser.selectedTab = newTab; // required
                    browser.swapBrowsersAndCloseOther(newTab, sourceTab);
                }, {
                    argCount: "+",
                    literal: 1,
                    completer: function (context, args) {
                        switch (args.completeArg) {
                        case 0:
                            if (args["-group"])
                                completion.tabGroupIndex(context);
                            else {
                                context.filters.push(({ item }) => item != window);
                                completion.window(context);
                            }
                            break;
                        case 1:
                            if (!args["-group"]) {
                                let win = dactyl.windows[Number(args[0]) - 1];
                                if (!win || !win.dactyl)
                                    context.message = _("Error", _("window.noIndex", winIndex));
                                else
                                    win.dactyl.modules.commands.get("tabmove").completer(context);
                            }
                            break;
                        }
                    },
                    options: [
                        {
                            names: ["-group", "-g"],
                            description: "Attach to a group rather than a window",
                            type: CommandOption.NOARG
                        }
                    ]
                });
        }

        if (dactyl.has("tabs_undo")) {
            commands.add(["u[ndo]"],
                "Undo closing of a tab",
                function (args) {
                    if (args.length)
                        args = args[0];
                    else
                        args = args.count || 0;

                    let m = /^(\d+)(:|$)/.exec(args || '1');
                    if (m)
                        window.undoCloseTab(Number(m[1]) - 1);
                    else if (args) {
                        for (let [i, item] of iter(tabs.closedTabs))
                            if (item.state.entries[item.state.index - 1].url == args) {
                                window.undoCloseTab(i);
                                return;
                            }

                        dactyl.echoerr(_("buffer.noClosed"));
                    }
                }, {
                    argCount: "?",
                    completer: function (context) {
                        context.anchored = false;
                        context.compare = CompletionContext.Sort.unsorted;
                        context.filters = [CompletionContext.Filter.textDescription];
                        context.keys = {
                            text: function ([i, { state: s }]) {
                                return (i + 1) + ": " + s.entries[s.index - 1].url;
                            },
                            description: "[1].title",
                            icon: "[1].image"
                        };
                        context.completions = tabs.closedTabs.entries();
                    },
                    count: true,
                    literal: 0,
                    privateData: true
                });

            commands.add(["undoa[ll]"],
                "Undo closing of all closed tabs",
                function () {
                    for (let i of iter(tabs.closedTabs))
                        window.undoCloseTab(0);
                },
                { argCount: "0" });

        }

        if (dactyl.has("session")) {
            commands.add(["wqa[ll]", "wq", "xa[ll]"],
                "Save the session and quit",
                function () { dactyl.quit(true); },
                { argCount: "0" });
        }
    },
    completion: function initCompletion() {

        completion.buffer = function buffer(context, visible) {
            let { tabs } = modules;

            let filter = context.filter.toLowerCase();

            context.pushProcessor(0, function (item, text, next) {
                return [
                    ["span", { highlight: "Indicator", style: "display: inline-block;" },
                        item.indicator],
                    next.call(this, item, text)
                ];
            });
            context.process[1] = function (item, text) {
                return template.bookmarkDescription(item, template.highlightFilter(text, this.filter));
            };

            context.anchored = false;
            context.keys = {
                text: "text",
                description: "url",
                indicator: function (item) {
                    return item.tab === tabs.getTab()  ? "%" :
                           item.tab === tabs.alternate ? "#" : " ";
                },
                icon: "icon",
                id: "id",
                command: function () { return "tabs.select"; }
            };
            context.compare = CompletionContext.Sort.number;
            context.filters[0] = CompletionContext.Filter.textDescription;

            let n = 0;

            let groups = [{ getTitle: () => "Pinned Tabs", getChildren: () => tabs.visibleTabs.filter((item) => item.pinned).map(function (item) { return {tab: item}; }) }];
            groups = groups.concat((visible) ? [tabs.getGroups().GroupItems.getActiveGroupItem()] : tabs.getGroups().GroupItems.groupItems);

            groups.forEach((group, i) =>
                context.fork(i, 0, this, function (context, group) {
                    context.title = [group.getTitle() || "Tabs"];
                    context.generate = () =>
                        group.getChildren().map(function ({ tab }) {
                            let url = tab.linkedBrowser.contentDocument.location.href;

                            return {
                                text: [++n + ": " + (tab.label || "(Untitled)"), n + ": " + url],
                                tab: tab,
                                id: n,
                                url: url,
                                icon: tab.image || BookmarkCache.DEFAULT_FAVICON
                            };
                        });
                }, group)
            );
        };

        completion.tabGroup = function tabGroup(context) {
            context.title = ["Tab Groups"];
            context.anchored = false;
            context.keys = {
                text: (group) => [group.i + ": " + (group.getTitle() || "(Untitled)")],
                description: (group) => group.getChildren().map(t => t.tab.label).join(", ")
            };
            context.compare = CompletionContext.Sort.number;
            context.generate = () => {
                context.incomplete = true;
                tabs.getGroups(function ({ GroupItems }) {
                    context.incomplete = false;
                    GroupItems.groupItems.forEach((item, i) => {
                        item.i = i + 1;
                        return item;
                    });
                    context.completions = GroupItems.groupItems;
                });
            };
        };

        completion.tabGroupIndex = function tabGroup(context) {
            context.title = ["Tab Groups"];
            context.keys = {
                text: "id",
                description: function (group) {
                    return group.getTitle() ||
                           group.getChildren().map(t => t.tab.label)
                                              .join(", ");
                }
            };
            context.generate = () => {
                context.incomplete = true;
                tabs.getGroups(function ({ GroupItems }) {
                    context.incomplete = false;
                    context.completions = GroupItems.groupItems;
                });
            };
        };
    },
    events: function initEvents() {
        let tabContainer = gBrowser.mTabContainer;
        function callback() {
            tabs.timeout(function () { this.updateTabCount(); });
        }
        for (let event of ["TabMove", "TabOpen", "TabClose"])
            events.listen(tabContainer, event, callback, false);
        events.listen(tabContainer, "TabSelect", tabs.bound._onTabSelect, false);
    },
    mappings: function initMappings() {

        mappings.add([modes.COMMAND], ["<C-t>", "<new-tab-next>"],
            "Execute the next mapping in a new tab",
            function ({ count }) {
                dactyl.forceTarget = dactyl.NEW_TAB;
                mappings.afterCommands((count || 1) + 1, () => {
                    dactyl.forceTarget = null;
                });
            },
            { count: true });

        mappings.add([modes.NORMAL], ["g0", "g^"],
            "Go to the first tab",
            function () { tabs.select(0); });

        mappings.add([modes.NORMAL], ["g$"],
            "Go to the last tab",
            function () { tabs.select("$"); });

        mappings.add([modes.NORMAL], ["gt"],
            "Go to the next tab",
            function ({ count }) {
                if (count != null)
                    tabs.select(count - 1, false);
                else
                    tabs.select("+1", true);
            },
            { count: true });

        mappings.add([modes.NORMAL], ["<C-n>", "<C-Tab>", "<C-PageDown>"],
            "Go to the next tab",
            function ({ count }) { tabs.select("+" + (count || 1), true); },
            { count: true });

        mappings.add([modes.NORMAL], ["gT", "<C-p>", "<C-S-Tab>", "<C-PageUp>"],
           "Go to previous tab",
            function ({ count }) { tabs.select("-" + (count || 1), true); },
            { count: true });

        if (config.has("tabbrowser")) {
            mappings.add([modes.NORMAL], ["b"],
                "Open a prompt to switch tabs in all tab groups",
                function ({ count }) {
                    if (count != null && count <= tabs.allTabs.length) {
                        let allTabs = tabs.visibleTabs.filter((item) => item.pinned);

                        for (let group of tabs.getGroups().GroupItems.groupItems) {
                            for (let child of group.getChildren()) {
                                allTabs.push(child.tab);
                            }
                        }

                        tabs.select(allTabs[count-1]);
                    }
                    else
                        CommandExMode().open("buffer! ");
                },
                { count: true });

            mappings.add([modes.NORMAL], ["c"],
                "Open a prompt to switch tabs in current tab group",
                function ({ count }) {
                    if (count != null && count <= tabs.visibleTabs.length)
                        tabs.select(tabs.visibleTabs[count-1]);
                    else
                        CommandExMode().open("current! ");
                },
                { count: true});

            mappings.add([modes.NORMAL], ["e"],
                "Open a prompt to switch tab groups",
                function ({ count }) {
                    if (count != null && count <= tabs.getGroups().GroupItems.groupItems.length) {
                        tabs.select(tabs.getGroups().GroupItems.groupItems[count-1].getActiveTab().tab);
                    }
                    else
                        CommandExMode().open("tabgroup! ");
                },
                { count: true });

            mappings.add([modes.NORMAL], ["B"],
                "Show buffer list",
                function () { tabs.list(false); });

            mappings.add([modes.NORMAL], ["d"],
                "Delete current buffer",
                function ({ count }) { tabs.remove(tabs.getTab(), count || 1, false); },
                { count: true });

            mappings.add([modes.NORMAL], ["D"],
                "Delete current buffer, focus tab to the left",
                function ({ count }) { tabs.remove(tabs.getTab(), count || 1, true); },
                { count: true });

            mappings.add([modes.NORMAL], ["gb"],
                "Repeat last :buffer command",
                function ({ count }) { tabs.switchTo(null, null, count, false); },
                { count: true });

            mappings.add([modes.NORMAL], ["gB"],
                "Repeat last :buffer command in reverse direction",
                function ({ count }) { tabs.switchTo(null, null, count, true); },
                { count: true });

            // TODO: feature dependencies - implies "session"?
            if (dactyl.has("tabs_undo")) {
                mappings.add([modes.NORMAL], ["u"],
                    "Undo closing of a tab",
                    function ({ count }) { ex.undo({ "#": count }); },
                    { count: true });
            }

            mappings.add([modes.NORMAL], ["<C-^>", "<C-6>"],
                "Select the alternate tab or the [count]th tab",
                function ({ count }) {
                    if (count != null)
                        tabs.switchTo(String(count), false);
                    else
                        tabs.selectAlternateTab();
                },
                { count: true });
        }
    },
    options: function initOptions() {
        options.add(["showtabline", "stal"],
            "Define when the tab bar is visible",
            "string", true,
            {
                setter: function (value) {
                    if (value === "never")
                        tabs.tabStyle.enabled = true;
                    else {
                        prefs.safeSet("browser.tabs.autoHide", value === "multitab",
                                      _("option.safeSet", "showtabline"));
                        tabs.tabStyle.enabled = false;
                    }

                    if (value !== "multitab")
                        if (tabs.xulTabs)
                            tabs.xulTabs.visible = value !== "never";
                        else
                            config.tabStrip.collapsed = false;

                    if (gBrowser.tabContainer._positionPinnedTabs)
                        gBrowser.tabContainer._positionPinnedTabs();
                    return value;
                },
                values: {
                    "never":    "Never show the tab bar",
                    "multitab": "Show the tab bar when there are multiple tabs",
                    "always":   "Always show the tab bar"
                }
            });

        if (config.has("tabbrowser")) {
            let activateGroups = [
                ["all", "Activate everything"],
                ["addons", ":addo[ns] command"],
                ["bookmarks", "Tabs loaded from bookmarks", "loadBookmarksInBackground"],
                ["diverted", "Links with targets set to new tabs", "loadDivertedInBackground"],
                ["downloads", ":downl[oads] command"],
                ["extoptions", ":exto[ptions] command"],
                ["help", ":h[elp] command"],
                ["homepage", "gH mapping"],
                ["links", "Middle- or Control-clicked links", "loadInBackground"],
                ["quickmark", "go and gn mappings"],
                ["tabopen", ":tabopen[!] command"],
                ["paste", "P and gP mappings"]
            ];
            options.add(["activate", "act"],
                "Define when newly created tabs are automatically activated",
                "stringlist", activateGroups.slice(1)
                                            .filter(g => (!g[2] ||
                                                          !prefs.get("browser.tabs." + g[2])))
                                            .map(g => g[0])
                                            .join(","),
                {
                    values: activateGroups,
                    has: Option.has.toggleAll,
                    setter: function (newValues) {
                        let valueSet = new RealSet(newValues);
                        for (let group of activateGroups)
                            if (group[2])
                                prefs.safeSet("browser.tabs." + group[2],
                                              !(valueSet.has("all") ^ valueSet.has(group[0])),
                                              _("option.safeSet", "activate"));
                        return newValues;
                    }
                });

            options.add(["newtab"],
                "Define which commands should output in a new tab by default",
                "stringlist", "",
                {
                    values: {
                        "all": "All commands",
                        "extoptions": ":exto[ptions] command",
                        "help": ":h[elp] command",
                        "prefs": ":pref[erences]! or :prefs! command"
                    },
                    has: Option.has.toggleAll
                });

            // TODO: Is this really applicable to Melodactyl?
            options.add(["popups", "pps"],
                "Where to show requested popup windows",
                "stringlist", "tab",
                {
                    setter: function (values) {
                        let open = 1, restriction = 0;
                        for (let opt of values) {
                            if (opt == "tab")
                                open = 3;
                            else if (opt == "window")
                                open = 2;
                            else if (opt == "resized")
                                restriction = 2;
                        }

                        prefs.safeSet("browser.link.open_newwindow", open,
                                      _("option.safeSet", "popups"));
                        prefs.safeSet("browser.link.open_newwindow.restriction", restriction,
                                      _("option.safeSet", "popups"));
                        return values;
                    },
                    values: {
                        "tab":     "Open popups in a new tab",
                        "window":  "Open popups in a new window",
                        "resized": "Open resized popups in a new window"
                    }
                });
        }
    }
});

// vim: set fdm=marker sw=4 sts=4 ts=8 et:
