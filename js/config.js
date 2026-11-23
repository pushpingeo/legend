export const CONFIG = {
  // Same Cloudflare Worker as the first demo: it holds the API key, pins the model,
  // caps max_tokens and rate-limits each visitor. Empty = live mapping only with your own key.
  proxyUrl: "https://north-sea-geo-demo.robdunfey.workers.dev",
  model: "claude-haiku-5-5",
  maxTokens: 8000,

  basemapStyle: "https://tiles.openfreemap.org/styles/positron",

  regions: {
    north_sea: { center: [1.4, 57.6], zoom: 6.6 },
    gulf: { center: [-90.6, 28.4], zoom: 6.6 },
  },

  // Services offered under "Apply it to another service".
  tryExamples: [
    {
      label: "BOEM Pacific wells",
      url: "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Outer_Continental_Shelf_Oil_and_Natural_Gas_Wells_Pacific_Region/FeatureServer/0",
    },
    {
      label: "BOEM Alaska wells",
      url: "https://services7.arcgis.com/G5Ma95RzqJRPKsWL/ArcGIS/rest/services/Outer_Continental_Shelf_Oil_and_Natural_Gas_Wells_BOEM_Alaska_Region_/FeatureServer/0",
    },
    {
      label: "NSTA licences",
      url: "https://services-eu1.arcgis.com/OZMfUznmLTnWccBc/ArcGIS/rest/services/UKCS offshore petroleum licences WGS84/FeatureServer/0",
    },
  ],
};
