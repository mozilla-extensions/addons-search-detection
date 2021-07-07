/* global ExtensionCommon, ExtensionAPI, Services, XPCOMUtils */
const { SearchUtils } = ChromeUtils.import(
  "resource://gre/modules/SearchUtils.jsm"
);
const { WebRequest } = ChromeUtils.import(
  "resource://gre/modules/WebRequest.jsm"
);
const { AddonManager } = ChromeUtils.import(
  "resource://gre/modules/AddonManager.jsm"
);

XPCOMUtils.defineLazyGlobalGetters(this, ["ChannelWrapper"]);

XPCOMUtils.defineLazyServiceGetter(
  Services,
  "eTLD",
  "@mozilla.org/network/effective-tld-service;1",
  "nsIEffectiveTLDService"
);

this.addonsSearchExperiment = class extends ExtensionAPI {
  onStartup() {}

  makeOnSearchEngineModified(context) {
    return new ExtensionCommon.EventManager({
      context,
      name: "addonsSearchExperiment.onSearchEngineModified",
      register: (fire) => {
        const onSearchEngineModifiedObserver = {
          observe(aSubject, aTopic, aData) {
            if (aTopic !== SearchUtils.TOPIC_ENGINE_MODIFIED) {
              return;
            }

            fire.async(aData);
          },
        };

        Services.obs.addObserver(
          onSearchEngineModifiedObserver,
          SearchUtils.TOPIC_ENGINE_MODIFIED
        );

        return () => {
          Services.obs.removeObserver(
            onSearchEngineModifiedObserver,
            SearchUtils.TOPIC_ENGINE_MODIFIED
          );
        };
      },
    }).api();
  }

  getAPI(context) {
    return {
      addonsSearchExperiment: {
        // `getMatchPatterns()` returns a map where each key is an URL pattern
        // to monitor and its corresponding value is an add-on ID (search
        // engine).
        //
        // Note: We don't return a simple list of URL patterns because the
        // background script might want to lookup the add-on ID for a given
        // URL.
        async getMatchPatterns() {
          const patterns = {};

          try {
            const visibleEngines = await Services.search.getVisibleEngines();

            visibleEngines.forEach((engine) => {
              let { _extensionID, _urls } = engine;

              _urls.forEach(({ template }) => {
                // If this is changed, double check the code in the background
                // script because `webRequestCancelledHandler` splits patterns
                // on `*` to retrieve URL prefixes.
                const pattern = template.split("?")[0] + "*";
                patterns[pattern] = _extensionID;
              });
            });
          } catch (err) {
            Cu.reportError(err);
          }

          return patterns;
        },

        // `getRequestProperty()` returns the property identified by
        // `propertyName` for a given `requestId` (= channel ID). This might
        // not return a value if the channel does not exist anymore or there is
        // no such property.
        async getRequestProperty(requestId, propertyName) {
          const wrapper = ChannelWrapper.getRegisteredChannel(
            requestId,
            context.extension.policy,
            context.xulBrowser.frameLoader.remoteTab
          );

          try {
            return wrapper?.channel
              ?.QueryInterface(Ci.nsIPropertyBag)
              ?.getProperty(propertyName);
          } catch {
            // It is possible the property does not exist (or everything
            // miserably failed).
            return null;
          }
        },

        // `getRequestUrl()` returns the original URL of a request given its
        // ID. This is needed when a request has been redirected and we want to
        // retrieve the new URL after the redirect.
        async getRequestUrl(requestId) {
          const wrapper = ChannelWrapper.getRegisteredChannel(
            requestId,
            context.extension.policy,
            context.xulBrowser.frameLoader.remoteTab
          );

          return wrapper?.channel?.name;
        },

        // `getAddonById()` returns add-on details if it exists. Note that it
        // does not return a full `add-on` object but a minimal object with
        // only the necessary information.
        async getAddonById(addonId) {
          const addon = await AddonManager.getAddonByID(addonId);

          return { version: addon.version };
        },

        // `getPublicSuffix()` returns the public suffix/Effective TLD Service
        // of the given URL.
        // See: https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsIEffectiveTLDService
        async getPublicSuffix(url) {
          try {
            return Services.eTLD.getBaseDomain(Services.io.newURI(url));
          } catch (err) {
            Cu.reportError(err);
            return null;
          }
        },

        // `onSearchEngineModified` is an event that occurs when the list of
        // search engines has changed, e.g., a new engine has been added or an
        // engine has been removed. Listeners receive the type of modification,
        // e.g., `engine-added`, `engine-removed`, etc.
        //
        // See: https://searchfox.org/mozilla-central/source/toolkit/components/search/SearchUtils.jsm#145-152
        onSearchEngineModified: this.makeOnSearchEngineModified(context),
      },
    };
  }
};
