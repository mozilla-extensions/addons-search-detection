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
    this.lastRequestIdReported = null;

    console.debug("registering telemetry events");
    browser.telemetry.registerEvents(TELEMETRY_CATEGORY, {
      [TELEMETRY_METHOD_ETLD_CHANGE]: {
        methods: [TELEMETRY_METHOD_ETLD_CHANGE],
        objects: [TELEMETRY_OBJECT_WEBREQUEST, TELEMETRY_OBJECT_OTHER],
        extra_keys: ["addonId", "addonVersion", "from", "to"],
        record_on_release: true,
      },
    });
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

  async monitor() {
    // If there is already a listener, remove it so that we can re-add one
    // after. This is because we're using the same listener with different URL
    // patterns (when the list of search engines changes).
    if (
      browser.webRequest.onBeforeRequest.hasListener(this.webRequestHandler)
    ) {
      console.debug("removing onBeforeRequest listener");
      browser.webRequest.onBeforeRequest.removeListener(this.webRequestHandler);
    }

    if (
      browser.webRequest.onBeforeRedirect.hasListener(this.webRequestHandler)
    ) {
      console.debug("removing onBeforeRedirect listener");
      browser.webRequest.onBeforeRedirect.removeListener(
        this.webRequestHandler
      );
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

    console.debug("registering onBeforeRequest listener");
    browser.webRequest.onBeforeRequest.addListener(
      this.webRequestHandler,
      { urls: patterns },
      ["blocking"]
    );

    // This one is needed in addition to `onBeforeRequest` because this
    // extension might be registered before or after some extensions.
    // Depending on that, our `onBeforeRequest` listener might not be called,
    // which is why we also listen to `onBeforeRedirect`.
    console.debug("registering onBeforeRedirect listener");
    browser.webRequest.onBeforeRedirect.addListener(this.webRequestHandler, {
      urls: patterns,
    });
  }

  // `redirectUrl` is usually valid when the redirect has been detected via
  // `onBeforeRedirect`, otherwise it's likely `undefined`.
  webRequestHandler = async ({ requestId, url, redirectUrl }) => {
    if (this.lastRequestIdReported === requestId) {
      console.debug(`request ID '${requestId}' already reported, skipping...`);
      return;
    }

    // When we detect a redirect, we read the request property, hoping to find
    // an add-on ID corresponding to the add-on that initiated the redirect.
    // It might not return anything when the redirect is a search server-side
    // redirect but it can also be caused by an error.
    let addonId = await browser.addonsSearchExperiment.getRequestProperty(
      requestId,
      "redirectedByExtension"
    );

    // When we did not find an add-on ID in the request property bag and the
    // `redirectUrl` is both valid and different than the original URL. we
    // likely detected a search server-side redirect.
    const isServerSideRedirect =
      !addonId && typeof redirectUrl !== "undefined" && url !== redirectUrl;

    // Search server-side redirects are possible because an extension has
    // registered a search engine, which is why we can (hopefully) retrieve the
    // add-on ID.
    if (isServerSideRedirect) {
      const id = this.getAddonIdFromUrl(url);

      // We shouldn't report built-in search engines.
      if (!id.endsWith("@search.mozilla.org")) {
        addonId = id;
      }
    }

    if (!addonId) {
      // No add-on ID means there is nothing we can report.
      return;
    }

    // This is the (initial) URL before the redirect.
    const from = await browser.addonsSearchExperiment.getPublicSuffix(url);

    // This is the URL after the redirect.
    const requestUrl =
      redirectUrl ||
      (await browser.addonsSearchExperiment.getRequestUrl(requestId));
    const to = await browser.addonsSearchExperiment.getPublicSuffix(requestUrl);

    if (from === to) {
      // We do not report redirects to same public suffixes.
      return;
    }

    // Hopefully this is "all" we need to prevent multiple Telemetry event
    // submissions, which might happen when both `onBeforeRequest` and
    // `onBeforeRedirect` listeners are called for the same request (which is
    // possible depending on the order of the registered listeners).
    this.lastRequestIdReported = requestId;

    const telemetryObject = isServerSideRedirect
      ? TELEMETRY_OBJECT_OTHER
      : TELEMETRY_OBJECT_WEBREQUEST;

    const telemetryValue = isServerSideRedirect
      ? TELEMETRY_VALUE_SERVER
      : TELEMETRY_VALUE_EXTENSION;

    // Get the add-on details we need to send as extra props.
    const addon = await browser.addonsSearchExperiment.getAddonById(addonId);

    const telemetryExtra = {
      addonId,
      addonVersion: addon.version,
      from,
      to,
    };

    this.recordEvent(
      TELEMETRY_METHOD_ETLD_CHANGE,
      telemetryObject,
      telemetryValue,
      telemetryExtra
    );
  };

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

  getAddonIdFromUrl(url) {
    for (const pattern of Object.keys(this.matchPatternsMap)) {
      const [urlPrefix] = pattern.split("*");

      if (url.startsWith(urlPrefix)) {
        return this.matchPatternsMap[pattern];
      }
    }

    return null;
  }
}

const start = async () => {
  const exp = new AddonsSearchExperiment();
  await exp.monitor();

  browser.addonsSearchExperiment.onSearchEngineModified.addListener(
    async (type) => {
      switch (type) {
        case "engine-added":
        case "engine-removed":
          // For these modified types, we want to reload the list of search
          // engines that are monitored, which is why we break to let the rest
          // of the code execute.
          break;

        default:
          return;
      }

      await exp.monitor();
    }
  );
};

start();
