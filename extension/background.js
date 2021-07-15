"use strict";

const TELEMETRY_CATEGORY = "addonsSearchExperiment";
// methods
const TELEMETRY_METHOD_ETLD_CHANGE = "etld_change";
// objects
const TELEMETRY_OBJECT_WEBREQUEST = "webrequest";
const TELEMETRY_OBJECT_OTHER = "other";
// values
const TELEMETRY_VALUE_EXTENSION = "extension";
const TELEMETRY_VALUE_SERVER = "server";

class AddonsSearchExperiment {
  constructor() {
    this.matchPatternsMap = {};
    // The key is a requestId.
    this.temporaryListenersMap = {};

    console.debug("registering telemetry events");
    browser.telemetry.registerEvents(TELEMETRY_CATEGORY, {
      [TELEMETRY_METHOD_ETLD_CHANGE]: {
        methods: [TELEMETRY_METHOD_ETLD_CHANGE],
        objects: [TELEMETRY_OBJECT_WEBREQUEST, TELEMETRY_OBJECT_OTHER],
        extra_keys: ["addonId", "addonVersion", "from", "to"],
        record_on_release: true,
      },
    });

    // This listener is used to clean up the temporary listeners used to follow
    // requests in the case of redirect chains. It will only clean up
    // successful requests. For other cases, we register a function with a long
    // timer (in `followRequestId()`).
    console.debug("registering onCompleted listener");
    browser.webRequest.onCompleted.addListener(
      ({ requestId }) => {
        this.removeTemporaryListenerIfNeeded(requestId);
      },
      { urls: ["<all_urls>"] }
    );
  }

  async getMatchPatterns() {
    try {
      this.matchPatternsMap =
        await browser.addonsSearchExperiment.getMatchPatterns();
    } catch (err) {
      console.error(`failed to retrieve the list of URL patterns: ${err}`);
      this.matchPatternsMap = {};
    }

    return this.matchPatternsMap;
  }

  // When the search service changes the set of engines that are enabled, we
  // update our pattern matching in the webrequest listeners (go to the bottom
  // of this file for the search service events we listen to).
  async monitor() {
    // If there is already a listener, remove it so that we can re-add one
    // after. This is because we're using the same listener with different URL
    // patterns (when the list of search engines changes).
    if (
      browser.addonsSearchExperiment.onBeforeRedirect.hasListener(
        this.webRequestHandler
      )
    ) {
      console.debug("removing onBeforeRedirect listener");
      browser.addonsSearchExperiment.onBeforeRedirect.removeListener(
        this.webRequestHandler
      );
    }

    if (browser.webRequest.onBeforeRequest.hasListener(this.noOpHandler)) {
      browser.webRequest.onBeforeRequest.removeListener(this.noOpHandler);
    }

    // Retrieve the list of URL patterns to monitor with our listener.
    //
    // Note: search suggestions are system principal requests, so webRequest
    // cannot intercept them.
    const matchPatternsMap = await this.getMatchPatterns();
    const patterns = Object.keys(matchPatternsMap);

    if (patterns.length === 0) {
      console.debug(
        "not registering any listener because there is no URL to monitor"
      );
      return;
    }

    // This is needed to force the registration of a traceable channel.
    browser.webRequest.onBeforeRequest.addListener(
      this.noOpHandler,
      { urls: patterns },
      ["blocking"]
    );

    console.debug("registering onBeforeRedirect listener");
    browser.addonsSearchExperiment.onBeforeRedirect.addListener(
      this.webRequestHandler,
      { urls: patterns }
    );
  }

  noOpHandler = () => {
    // Do nothing.
  };

  webRequestHandler = async ({
    addonId,
    redirectUrl,
    requestId,
    url,
    // Only set in the case of a redirect chain.
    addonIds,
  }) => {
    // When we do not have an add-on ID (in the request property bag) and the
    // `redirectUrl` is different than the original URL. we likely detected a
    // search server-side redirect.
    const isServerSideRedirect = !addonId && url !== redirectUrl;

    // Search server-side redirects are possible because an extension has
    // registered a search engine, which is why we can (hopefully) retrieve the
    // add-on ID.
    if (!addonIds && isServerSideRedirect) {
      addonIds = this.getAddonIdsForUrl(url);
    } else if (addonId) {
      addonIds = [addonId];
    }

    if (addonIds.length === 0) {
      // No add-on ID means there is nothing we can report.
      return;
    }

    // This is the (initial) URL before the redirect.
    const from = await browser.addonsSearchExperiment.getPublicSuffix(url);
    // This is the URL after the redirect.
    const to = await browser.addonsSearchExperiment.getPublicSuffix(
      redirectUrl
    );

    if (from === to) {
      if (isServerSideRedirect) {
        // This could be a redirect chain so let's register a new listener to
        // "follow" the request (ID).
        this.followRequestId({ addonIds, requestId, redirectUrl });
      }

      // We do not report redirects to same public suffixes. However, we will
      // report redirects from public suffixes belonging to a same entity
      // (.e.g., `example.com` -> `example.fr`).
      return;
    }

    const telemetryObject = isServerSideRedirect
      ? TELEMETRY_OBJECT_OTHER
      : TELEMETRY_OBJECT_WEBREQUEST;

    const telemetryValue = isServerSideRedirect
      ? TELEMETRY_VALUE_SERVER
      : TELEMETRY_VALUE_EXTENSION;

    for (const addonId of addonIds) {
      const addonVersion = await browser.addonsSearchExperiment.getAddonVersion(
        addonId
      );

      this.recordEvent(
        TELEMETRY_METHOD_ETLD_CHANGE,
        telemetryObject,
        telemetryValue,
        { addonId, addonVersion, from, to }
      );
    }
  };

  // Remove a temporary listener bound to a requestId if it exists. These
  // temporary listeners are used to support redirect chains.
  removeTemporaryListenerIfNeeded(requestId) {
    if (this.temporaryListenersMap[requestId]) {
      const { listener, timeoutId } = this.temporaryListenersMap[requestId];

      console.debug(`removing temporary listener for requestId=${requestId}`);
      clearTimeout(timeoutId);
      browser.webRequest.onBeforeRequest.removeListener(listener);

      delete this.temporaryListenersMap[requestId];
    }
  }

  // This is used when we detect a "server side redirect" but the "from" and
  // "to" eTLDs are the same. In this case, we want to follow the redirect
  // chain in case there is a server side redirect to a different eTLD
  // somewhere.
  followRequestId({ addonIds, requestId, redirectUrl, redirectChain }) {
    console.debug(
      `following requestId=${requestId} addonIds=${JSON.stringify(addonIds)}`
    );

    this.removeTemporaryListenerIfNeeded(requestId);

    const listener = (details) => {
      // If the requestId is the same as the one to "follow", we call our
      // handler that contains the logic to record events if needed.
      if (details.requestId === requestId) {
        this.webRequestHandler({
          requestId,
          url: redirectUrl,
          redirectUrl: details.url,
          addonIds,
        });
      }
    };

    console.debug(`adding temporary listener for requestId=${requestId}`);
    browser.webRequest.onBeforeRequest.addListener(
      listener,
      { urls: ["<all_urls>"] },
      ["blocking"]
    );

    // This is a fallback in case something goes wrong, e.g., cancelled or
    // errored request.
    const timeoutId = setTimeout(() => {
      this.removeTemporaryListenerIfNeeded(requestId);
    }, 60 * 1000);

    // We store this listener in a map indexed by the requestId because this ID
    // is unique and we only want 1 listener per requestId at the same time.
    // The value of the map contains the listener as well as a timeout ID for
    // the clean-up function (fallback).
    this.temporaryListenersMap[requestId] = { timeoutId, listener };
  }

  recordEvent(method, object, value, extra) {
    console.debug(
      `recording event: method=${method} object=${object} value=${value} extra=${JSON.stringify(
        extra
      )}`
    );

    browser.telemetry.recordEvent(
      TELEMETRY_CATEGORY,
      method,
      object,
      value,
      extra
    );
  }

  getAddonIdsForUrl(url) {
    for (const pattern of Object.keys(this.matchPatternsMap)) {
      const [urlPrefix] = pattern.split("*");

      if (url.startsWith(urlPrefix)) {
        return this.matchPatternsMap[pattern];
      }
    }

    return [];
  }
}

const exp = new AddonsSearchExperiment();
exp.monitor();

browser.addonsSearchExperiment.onSearchEngineModified.addListener(async () => {
  await exp.monitor();
});
