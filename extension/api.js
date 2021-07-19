/* global ExtensionCommon, ExtensionAPI, Services, XPCOMUtils */
const { AddonManager } = ChromeUtils.import(
  "resource://gre/modules/AddonManager.jsm"
);
const { WebRequest } = ChromeUtils.import(
  "resource://gre/modules/WebRequest.jsm"
);

XPCOMUtils.defineLazyGlobalGetters(this, ["ChannelWrapper"]);

XPCOMUtils.defineLazyServiceGetter(
  this,
  "eTLD",
  "@mozilla.org/network/effective-tld-service;1",
  "nsIEffectiveTLDService"
);

XPCOMUtils.defineLazyGetter(global, "searchInitialized", () => {
  if (Services.search.isInitialized) {
    return Promise.resolve();
  }

  return ExtensionUtils.promiseObserved(
    "browser-search-service",
    (_, data) => data === "init-complete"
  );
});

const SEARCH_TOPIC_ENGINE_MODIFIED = "browser-search-engine-modified";

this.addonsSearchExperiment = class extends ExtensionAPI {
  getAPI(context) {
    const { extension } = context;

    return {
      addonsSearchExperiment: {
        // `getMatchPatterns()` returns a map where each key is an URL pattern
        // to monitor and its corresponding value is a list of add-on IDs
        // (search engines).
        //
        // Note: We don't return a simple list of URL patterns because the
        // background script might want to lookup add-on IDs for a given URL.
        async getMatchPatterns() {
          const patterns = {};

          try {
            await searchInitialized;
            const visibleEngines = await Services.search.getEngines();

            visibleEngines.forEach((engine) => {
              let { _extensionID, _urls } = engine;

              _urls.forEach(({ template }) => {
                // If this is changed, double check the code in the background
                // script because `webRequestCancelledHandler` splits patterns
                // on `*` to retrieve URL prefixes.
                const pattern = template.split("?")[0] + "*";

                // Multiple search engines could register URL templates that
                // would become the same URL pattern as defined above so we
                // store a list of extension IDs per URL pattern.
                if (!patterns[pattern]) {
                  patterns[pattern] = [_extensionID];
                } else if (!patterns[pattern].includes(_extensionID)) {
                  patterns[pattern].push(_extensionID);
                }
              });
            });
          } catch (err) {
            Cu.reportError(err);
          }

          return patterns;
        },

        // `getAddonVersion()` returns the add-on version if it exists.
        async getAddonVersion(addonId) {
          const addon = await AddonManager.getAddonByID(addonId);

          return addon && addon.version;
        },

        // `getPublicSuffix()` returns the public suffix/Effective TLD Service
        // of the given URL.
        // See: https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsIEffectiveTLDService
        async getPublicSuffix(url) {
          try {
            return eTLD.getBaseDomain(Services.io.newURI(url));
          } catch (err) {
            Cu.reportError(err);
            return null;
          }
        },

        // `onSearchEngineModified` is an event that occurs when the list of
        // search engines has changed, e.g., a new engine has been added or an
        // engine has been removed.
        //
        // See: https://searchfox.org/mozilla-central/source/toolkit/components/search/SearchUtils.jsm#145-152
        onSearchEngineModified: new ExtensionCommon.EventManager({
          context,
          name: "addonsSearchExperiment.onSearchEngineModified",
          register: (fire) => {
            const onSearchEngineModifiedObserver = (
              aSubject,
              aTopic,
              aData
            ) => {
              if (
                aTopic !== SEARCH_TOPIC_ENGINE_MODIFIED ||
                // We are only interested in these modified types.
                !["engine-added", "engine-removed", "engine-changed"].includes(
                  aData
                )
              ) {
                return;
              }

              fire.async();
            };

            Services.obs.addObserver(
              onSearchEngineModifiedObserver,
              SEARCH_TOPIC_ENGINE_MODIFIED
            );

            return () => {
              Services.obs.removeObserver(
                onSearchEngineModifiedObserver,
                SEARCH_TOPIC_ENGINE_MODIFIED
              );
            };
          },
        }).api(),

        // `onBeforeRedirect` is an event very similar to the public web
        // request `onBeforeRedirect` but it is registered in the privileged
        // code to make sure that we can read properties on a valid channel
        // (wrapper). The registered listeners will received the `addonId` in
        // addition to these props: `requestId`, `url` and `redirectUrl`.
        onBeforeRedirect: new ExtensionCommon.EventManager({
          context,
          name: "addonsSearchExperiment.onBeforeRedirect",
          register: (fire, filter) => {
            const listener = ({ requestId, url, redirectUrl }) => {
              const wrapper = ChannelWrapper.getRegisteredChannel(
                requestId,
                context.extension.policy,
                context.xulBrowser.frameLoader.remoteTab
              );

              // When we detect a redirect, we read the request property,
              // hoping to find an add-on ID corresponding to the add-on that
              // initiated the redirect. It might not return anything when the
              // redirect is a search server-side redirect but it can also be
              // caused by an error.
              let addonId;

              try {
                addonId = wrapper?.channel
                  ?.QueryInterface(Ci.nsIPropertyBag)
                  ?.getProperty("redirectedByExtension");
              } catch (err) {
                Cu.reportError(err);
              }

              fire.async({ addonId, redirectUrl, requestId, url });
            };

            WebRequest.onBeforeRedirect.addListener(
              listener,
              // filter
              {
                types: ["main_frame"],
                urls: ExtensionUtils.parseMatchPatterns(filter.urls),
              },
              // info
              [],
              // listener details
              {
                addonId: extension.id,
                policy: extension.policy,
                blockingAllowed: false,
              }
            );

            return () => {
              WebRequest.onBeforeRedirect.removeListener(listener);
            };
          },
        }).api(),
      },
    };
  }
};
