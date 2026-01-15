# Changelog

## [0.0.13](https://github.com/open-meteo/mapbox-layer/compare/v0.0.12...v0.0.13) (2026-01-15)


### Features

* Automatic partial requests via updateCurrentBounds hook ([#146](https://github.com/open-meteo/mapbox-layer/issues/146)) ([e833243](https://github.com/open-meteo/mapbox-layer/commit/e8332430d1fdab19e9615f4f2863ceba2ef1f227))


### Bug Fixes

* bump the openmeteo group with 4 updates ([#151](https://github.com/open-meteo/mapbox-layer/issues/151)) ([323da34](https://github.com/open-meteo/mapbox-layer/commit/323da34ed37ae493eeae0f160e29f36567a24f17))
* Interpolation across dateline ([#148](https://github.com/open-meteo/mapbox-layer/issues/148)) ([6ad0355](https://github.com/open-meteo/mapbox-layer/commit/6ad03559d80258d9ef5709ad6e62402a0b6ae959))
* remove assertion for valid om urls ([#153](https://github.com/open-meteo/mapbox-layer/issues/153)) ([bd46b31](https://github.com/open-meteo/mapbox-layer/commit/bd46b31eff97568f2b03f6e016336bbfcae71854))

## [0.0.12](https://github.com/open-meteo/mapbox-layer/compare/v0.0.11...v0.0.12) (2026-01-07)


### Features

* Boundary clipping ([#91](https://github.com/open-meteo/mapbox-layer/issues/91)) ([9185ef6](https://github.com/open-meteo/mapbox-layer/commit/9185ef690b59fa3e3aa2ccbddcea9e6135331498))


### Bug Fixes

* Capture API requests on every tile ([#142](https://github.com/open-meteo/mapbox-layer/issues/142)) ([3b116a2](https://github.com/open-meteo/mapbox-layer/commit/3b116a26a15e5f85b44224fb311de72bdc10e797))

## [0.0.11](https://github.com/open-meteo/mapbox-layer/compare/v0.0.10...v0.0.11) (2025-12-30)


### Bug Fixes

* bump the openmeteo group with 4 updates ([#137](https://github.com/open-meteo/mapbox-layer/issues/137)) ([4b134bd](https://github.com/open-meteo/mapbox-layer/commit/4b134bd4a8de82e48fdba72b7757a9ec51a572ab))
* Correctly normalize longitude values everywhere ([#138](https://github.com/open-meteo/mapbox-layer/issues/138)) ([f845bd8](https://github.com/open-meteo/mapbox-layer/commit/f845bd88575e5bb1927f164ddad27eedb392a515))

## [0.0.10](https://github.com/open-meteo/mapbox-layer/compare/v0.0.9...v0.0.10) (2025-12-22)


### Features

* 3 point interpolation for gaussian grid ([#133](https://github.com/open-meteo/mapbox-layer/issues/133)) ([42cc2ac](https://github.com/open-meteo/mapbox-layer/commit/42cc2ac87e1e237fe866b8921e2e4ce50e3cfdd9))
* Add codecov ([#127](https://github.com/open-meteo/mapbox-layer/issues/127)) ([29ad165](https://github.com/open-meteo/mapbox-layer/commit/29ad165825bfe54913974c81e76cdc042500f475))
* Longitude wrapping for regular grids ([#132](https://github.com/open-meteo/mapbox-layer/issues/132)) ([8cbaf4a](https://github.com/open-meteo/mapbox-layer/commit/8cbaf4a5d14642cd7d1d3c5cca7b78f8892defd4))
* More flexible domain discovery ([#135](https://github.com/open-meteo/mapbox-layer/issues/135)) ([f69dd51](https://github.com/open-meteo/mapbox-layer/commit/f69dd51d3172e51cef380d8016e9eaec3571fdf4))


### Bug Fixes

* Add codecov dependenies ([#128](https://github.com/open-meteo/mapbox-layer/issues/128)) ([151af93](https://github.com/open-meteo/mapbox-layer/commit/151af930424fb3504cc2916f779ab2e2cc54ef1a))
* Add opacity to paint property in examples ([#130](https://github.com/open-meteo/mapbox-layer/issues/130)) ([9bbaaa8](https://github.com/open-meteo/mapbox-layer/commit/9bbaaa8c5ab67bf4003495096e5c79ec92d1cb72))
* Attempt to slice on null ([#131](https://github.com/open-meteo/mapbox-layer/issues/131)) ([3d929ac](https://github.com/open-meteo/mapbox-layer/commit/3d929ac9373d1201dcf2eee39c174ceac449a371))
* Bump maplibre-gl from 5.13.0 to 5.14.0 in the openmeteo group ([#121](https://github.com/open-meteo/mapbox-layer/issues/121)) ([73d4246](https://github.com/open-meteo/mapbox-layer/commit/73d4246e37461c0f05aa73ee8745f45f49a78fa5))
* Bump the openmeteo group with 5 updates ([#136](https://github.com/open-meteo/mapbox-layer/issues/136)) ([c4fe97a](https://github.com/open-meteo/mapbox-layer/commit/c4fe97a62f56d295ea12a6d128b5ab2213e5a004))
* Interpolation artifacts due to numerical instabilities ([#120](https://github.com/open-meteo/mapbox-layer/issues/120)) ([2311906](https://github.com/open-meteo/mapbox-layer/commit/2311906b83df65810ef692a9a8a43c2ec1505c31))
* Outdated mapbox layer version in examples ([#134](https://github.com/open-meteo/mapbox-layer/issues/134)) ([bea2ae1](https://github.com/open-meteo/mapbox-layer/commit/bea2ae15744edf50d9666f5e461dc68084ce4276))

## [0.0.9](https://github.com/open-meteo/mapbox-layer/compare/v0.0.8...v0.0.9) (2025-12-15)


### Features

* Add combined variable example ([#103](https://github.com/open-meteo/mapbox-layer/issues/103)) ([c4ceed3](https://github.com/open-meteo/mapbox-layer/commit/c4ceed36bf679d323b2224d07e24f09db7a5f605))
* Add darkmode example ([#104](https://github.com/open-meteo/mapbox-layer/issues/104)) ([294d1ad](https://github.com/open-meteo/mapbox-layer/commit/294d1ad3ea09e5edef9018ede39d36a4788c426c))
* Add missing variable labels and remove variable type ([#105](https://github.com/open-meteo/mapbox-layer/issues/105)) ([6c576e7](https://github.com/open-meteo/mapbox-layer/commit/6c576e746a9b0f2d8f60f2411fd3a11791e09025))
* Custom contouring intervals and contouring intervals on breakpoints ([#116](https://github.com/open-meteo/mapbox-layer/issues/116)) ([132e3a8](https://github.com/open-meteo/mapbox-layer/commit/132e3a805376b0ebbf328ff1595e7e68a268998d))
* Improve reader derivation rules for values and directions ([#99](https://github.com/open-meteo/mapbox-layer/issues/99)) ([3722506](https://github.com/open-meteo/mapbox-layer/commit/3722506b2cbfd3902a8618d1145697b44633b692))
* Improve `time_interval` and `model_interval` of Domain type ([#100](https://github.com/open-meteo/mapbox-layer/issues/100)) ([5d383a1](https://github.com/open-meteo/mapbox-layer/commit/5d383a176e33113d2b7e2e196bf25266ab50d7f2))
* Rework colorscales ([#79](https://github.com/open-meteo/mapbox-layer/issues/79)) ([f9a75f4](https://github.com/open-meteo/mapbox-layer/commit/f9a75f42340f351708fcac17840169d429fac5bb)) ([#110](https://github.com/open-meteo/mapbox-layer/issues/110)) ([248950a](https://github.com/open-meteo/mapbox-layer/commit/248950a5d6d5fea43941b3d03c5b030a63827009))


### Bug Fixes

* Await `ensureData` before `getTileJson` ([#113](https://github.com/open-meteo/mapbox-layer/issues/113)) ([12a12e1](https://github.com/open-meteo/mapbox-layer/commit/12a12e18558a1dfa9c2c1d0223dd18b692783bef))
* Bump tsx from 4.20.6 to 4.21.0 in the openmeteo group ([#106](https://github.com/open-meteo/mapbox-layer/issues/106)) ([a398cdf](https://github.com/open-meteo/mapbox-layer/commit/a398cdfbc3a188ab3c43e85cf9d1351ad369031a))
* Change readme examples to capture api ([7c0b06a](https://github.com/open-meteo/mapbox-layer/commit/7c0b06af6930aa1142a8bbc4f527f3fb57857dce))

## [0.0.8](https://github.com/open-meteo/mapbox-layer/compare/v0.0.7...v0.0.8) (2025-12-02)


### Features

* Add GEM HRDPS West & ECMWF WAM + 0.25 ([e1035b7](https://github.com/open-meteo/mapbox-layer/commit/e1035b75ee6bfe4b941c1d16e99952a4f4af0ccb))
* Add GFS Wave 025 ([5169f48](https://github.com/open-meteo/mapbox-layer/commit/5169f482b171addefdfb3f9c16f9430461d50133))
* Isolate state of different variables ([#85](https://github.com/open-meteo/mapbox-layer/issues/85)) ([5a5bca8](https://github.com/open-meteo/mapbox-layer/commit/5a5bca850c94b80e13de100a2c128c114f1b8493))
* run lint during ci ([#83](https://github.com/open-meteo/mapbox-layer/issues/83)) ([29fd82e](https://github.com/open-meteo/mapbox-layer/commit/29fd82e37e9690138f88987c74e0fdf93dda34da))


### Bug Fixes

* add cooldown for dependabot ([72e9be3](https://github.com/open-meteo/mapbox-layer/commit/72e9be390822cec75f82d43252f6c820e21be656))
* allow 3 point interpolation ([506972a](https://github.com/open-meteo/mapbox-layer/commit/506972af553aeaa3d8e96e73afa8ef61d3ce7568))
* allow 3 point interpolation ([01f4f8b](https://github.com/open-meteo/mapbox-layer/commit/01f4f8b97d43834ae4eb504e03082f49dfe1a2ee))
* arrows with partials ([b47dc63](https://github.com/open-meteo/mapbox-layer/commit/b47dc63177354a34fe2bd118a61ac84fd2dbd5b4))
* broken link in Readme ([48dc374](https://github.com/open-meteo/mapbox-layer/commit/48dc37413bd8593fa0b69255e34ee2917ff36765))
* bump actions/checkout from 5 to 6 ([#94](https://github.com/open-meteo/mapbox-layer/issues/94)) ([6a57852](https://github.com/open-meteo/mapbox-layer/commit/6a5785271743fdce3219193665a50810df6ab4e1))
* bump the openmeteo group with 2 updates ([d5d4d6e](https://github.com/open-meteo/mapbox-layer/commit/d5d4d6ee9030eaff3ba4daaaf8a7e55cd7253ca1))
* bump the openmeteo group with 2 updates ([9c94901](https://github.com/open-meteo/mapbox-layer/commit/9c9490133b5f697ec1f250473539d50975da5585))
* OMUrl path in examples outdated ([c520b03](https://github.com/open-meteo/mapbox-layer/commit/c520b030342a7c92ee07fe87c8e34f91db720816))
* rename workflow ([d28db6a](https://github.com/open-meteo/mapbox-layer/commit/d28db6a77065fbabfa30e0bb9d48083a79a4bcb1))
* small ellaboration vector sources readme ([0d47c73](https://github.com/open-meteo/mapbox-layer/commit/0d47c737471d1b859b54f5023bfaa8eaf23f7aa5))
* update unplugin-dts to latest beta ([367dc6d](https://github.com/open-meteo/mapbox-layer/commit/367dc6d377fa5e5e3469836495c6d6713e735dde))

## [0.0.7](https://github.com/open-meteo/mapbox-layer/compare/v0.0.6...v0.0.7) (2025-11-12)


### Features

* add GFS Wave ([f82775d](https://github.com/open-meteo/mapbox-layer/commit/f82775d6d801ccf0b542ed6762bec12442978541))


### Bug Fixes

* bump the openmeteo group with 3 updates ([50c5bdf](https://github.com/open-meteo/mapbox-layer/commit/50c5bdf0c0ea72e006cec41a21286b9a2345b525))
* bump the openmeteo group with 3 updates ([71efdce](https://github.com/open-meteo/mapbox-layer/commit/71efdce800cf3ecb00a8cd3bf25ea4d7f7f02a2c))
* ranges ([102570a](https://github.com/open-meteo/mapbox-layer/commit/102570adc386ecc5e79f4421342f40c2f12ab40a))
* reenable minify ([9fe90d0](https://github.com/open-meteo/mapbox-layer/commit/9fe90d079902258852d1271ac63fc279467c640e))

## [0.0.6](https://github.com/open-meteo/mapbox-layer/compare/v0.0.5...v0.0.6) (2025-11-03)


### Features

* Add new seasonal data sources SEAS5 and EC46 from ECMWF ([ba178b0](https://github.com/open-meteo/mapbox-layer/commit/ba178b0911854dfb45521acdd2660fe57f1f0058))
* script to generate color scales ([#67](https://github.com/open-meteo/mapbox-layer/issues/67)) ([1c565e3](https://github.com/open-meteo/mapbox-layer/commit/1c565e36019952c1e38714558c60ae342fa352ef))
* Wind arrows from arrayBuffer ([fe76420](https://github.com/open-meteo/mapbox-layer/commit/fe764205d3c680a440bd474a328a37d14bf04859))


### Bug Fixes

* add marker for all examples and catch all in config ([f8c9b5a](https://github.com/open-meteo/mapbox-layer/commit/f8c9b5a257ed92be9d3b97a6666794428f8361fb))
* bump the openmeteo group with 4 updates ([5ee2e00](https://github.com/open-meteo/mapbox-layer/commit/5ee2e00fab73db820655db97ad9e777f84987d4b))
* bump the openmeteo group with 4 updates ([8b4bd12](https://github.com/open-meteo/mapbox-layer/commit/8b4bd12d4cf42db8076a8c47fbe59541c7955c29))
* comment wrap for readme ([2efc058](https://github.com/open-meteo/mapbox-layer/commit/2efc058ef648c170fdf04a2c537b431a6822cca6))
* explicit defintions in extra files release please ([4bae205](https://github.com/open-meteo/mapbox-layer/commit/4bae205c3378b94e7b47840dc5debab35508dd6e))
* link in readme is not correct ([#71](https://github.com/open-meteo/mapbox-layer/issues/71)) ([4a81823](https://github.com/open-meteo/mapbox-layer/commit/4a81823ee909b21e4a1a20f9495c86e974058dc8))
* try cathcall with extension ([78a1fca](https://github.com/open-meteo/mapbox-layer/commit/78a1fca271348f45c1b1a51b1ac7fd9a8ef7d618))

## [0.0.5](https://github.com/open-meteo/mapbox-layer/compare/v0.0.4...v0.0.5) (2025-10-31)


### Features

* better tests and type safety for projected grids ([#68](https://github.com/open-meteo/mapbox-layer/issues/68)) ([fb565a1](https://github.com/open-meteo/mapbox-layer/commit/fb565a19a96d8ed4ab131803404803e25bfc7540))
* cleanup projections ([#58](https://github.com/open-meteo/mapbox-layer/issues/58)) ([e2b011a](https://github.com/open-meteo/mapbox-layer/commit/e2b011a361f775bd65d866341f2164364357829e))


### Bug Fixes

* eslint setup ([#59](https://github.com/open-meteo/mapbox-layer/issues/59)) ([4a100d4](https://github.com/open-meteo/mapbox-layer/commit/4a100d4ad4f8f8ea3d150373e3afefa1f4deaf03))
* umd file name ([130f9e8](https://github.com/open-meteo/mapbox-layer/commit/130f9e83171321a42931ec0ddbdf7318b5bc1fca))

## [0.0.4](https://github.com/open-meteo/mapbox-layer/compare/v0.0.3...v0.0.4) (2025-10-28)

### Features

- simplify omaps reader interface ([48d81c7](https://github.com/open-meteo/mapbox-layer/commit/48d81c7750bf2e054849feb9362a13e0be08bb7b))
- Transfer buffer after worker process ([d222d54](https://github.com/open-meteo/mapbox-layer/commit/d222d543c3a6ac8ae5e07bc0673962a3fddf54ce))

### Bug Fixes

- bump the openmeteo group with 2 updates ([bab5e70](https://github.com/open-meteo/mapbox-layer/commit/bab5e70eda3c1627f6545290a8c23d0537c9d5f5))
- bump the openmeteo group with 2 updates ([312896d](https://github.com/open-meteo/mapbox-layer/commit/312896dd74efac24b9d956348ff00d08ae523791))
- detached buffer during contouring in worker ([64224f6](https://github.com/open-meteo/mapbox-layer/commit/64224f67b37f18a5ed0de30841948dd549221ba9))
- detached buffer during contouring in worker ([b2d2eaf](https://github.com/open-meteo/mapbox-layer/commit/b2d2eafd4158614a30829c9cf15b67e5ff9500c0))
- inconsistent colorscales between chrome and firefox ([3eac2e2](https://github.com/open-meteo/mapbox-layer/commit/3eac2e2c08c943f91a4cb50d488fb1365993f8ff))
- inconsistent colorscales between chrome and firefox ([c847469](https://github.com/open-meteo/mapbox-layer/commit/c847469be7a5e1693cf68ad8dec4ae930e7da1bd))
- Temporary fix for the dates in examples ([10a2671](https://github.com/open-meteo/mapbox-layer/commit/10a2671f73147b43c75d8595f2494842b45d4e1d))

## [0.0.3](https://github.com/open-meteo/mapbox-layer/compare/v0.0.2...v0.0.3) (2025-10-23)

### Features

- Contouring for pressure maps ([1052a1a](https://github.com/open-meteo/mapbox-layer/commit/1052a1a7e2551e278ffa09f584c2514c2b73904b))
- Typed omProtocol settings object ([7439ee7](https://github.com/open-meteo/mapbox-layer/commit/7439ee7037a3e7d0f6f112b003ad1e7283b6f9c3))

### Bug Fixes

- Move getIndexAndFractions outside of worker ([2ec1fd6](https://github.com/open-meteo/mapbox-layer/commit/2ec1fd641b0a008e1840aecf542796d205f7ce3e))
- release please publish step ([dec7921](https://github.com/open-meteo/mapbox-layer/commit/dec792199a0efcb1af620dedf754bfe4a6019eee))
- wrap longitude ([1f50d79](https://github.com/open-meteo/mapbox-layer/commit/1f50d79f921f2f30f69cccc1b011f4c3b6d1c462))

## [0.0.2](https://github.com/open-meteo/mapbox-layer/compare/v0.0.1...v0.0.2) (2025-10-21)

### Bug Fixes

- Expose gaussian ([18b644d](https://github.com/open-meteo/mapbox-layer/commit/18b644d8e318a868fc4bfdeb613528c47d548dfb))

## 0.0.1 (2025-10-21)

### Features

- Support Gaussian grids like O1280 for IFS HRES ([50f30ed](https://github.com/open-meteo/mapbox-layer/commit/50f30edf89a9f06808a13c4240112bf8755a862c))
- Support Gaussian grids like O1280 for IFS HRES ([aa18946](https://github.com/open-meteo/mapbox-layer/commit/aa1894617c101649b5ddedf4c63b0e47048f435d))

### Bug Fixes

- add test workflow ([3308b28](https://github.com/open-meteo/mapbox-layer/commit/3308b2876af2edabcc464bc199c0b7018c6031f7))
- Arrow with offscreen canvas ([453bed1](https://github.com/open-meteo/mapbox-layer/commit/453bed1644859a05d361202e2d7c5f73a172ac97))
- bump actions/checkout from 4 to 5 ([fab2e3d](https://github.com/open-meteo/mapbox-layer/commit/fab2e3d825e6359aab1049ac91688a0600eb92f6))
- bump actions/checkout from 4 to 5 ([72fbf84](https://github.com/open-meteo/mapbox-layer/commit/72fbf8428ba2527757c435bee53267f822dd0ee3))
- bump actions/setup-node from 4 to 6 ([b6ad5d6](https://github.com/open-meteo/mapbox-layer/commit/b6ad5d6f12e1396206999a2237167b62e47968d9))
- bump actions/setup-node from 4 to 6 ([229bf76](https://github.com/open-meteo/mapbox-layer/commit/229bf76759301c655d1a0f5a37cfa61eea7b9033))
- bump actions/setup-node from 5 to 6 ([7f43162](https://github.com/open-meteo/mapbox-layer/commit/7f43162c407e8455a6d909eec9040bc146853c2c))
- bump actions/setup-node from 5 to 6 ([292cff1](https://github.com/open-meteo/mapbox-layer/commit/292cff163ae3586c15fcd8adb69fc79a23c758c3))
- bump amannn/action-semantic-pull-request from 5.5.3 to 6.1.1 ([8c54ec8](https://github.com/open-meteo/mapbox-layer/commit/8c54ec8d6bf1c4e1f25cf67562f908d690946a71))
- bump amannn/action-semantic-pull-request from 5.5.3 to 6.1.1 ([407c4bd](https://github.com/open-meteo/mapbox-layer/commit/407c4bd582e97cd1db47bc02549538d2c0d5884e))
- Expose all functions ([740060f](https://github.com/open-meteo/mapbox-layer/commit/740060f5319e63cc9729d6d4b37bec563c1565c3))
- fastAtan2 special values ([e0ce642](https://github.com/open-meteo/mapbox-layer/commit/e0ce64221ff6e110ccdccc0c106155807f2051f4))
- initial release version is 0.0.1 ([8bb0824](https://github.com/open-meteo/mapbox-layer/commit/8bb08244f35053b9839269d439e71f16461aa57c))
- negative lon values ([b5381b9](https://github.com/open-meteo/mapbox-layer/commit/b5381b9f2d6580b575ead90d5f2214ca0897d5a4))
- release please config ([a6a0491](https://github.com/open-meteo/mapbox-layer/commit/a6a04913831d20267931456b5bc9e7b491bc0f34))
- release please manifest version ([28e4a72](https://github.com/open-meteo/mapbox-layer/commit/28e4a725b3461a79d4839234b5ae5eeac8291dd3))
- Wind values for ifs hres ([07ed3e5](https://github.com/open-meteo/mapbox-layer/commit/07ed3e5fd9ca8d5d58166619c461c3294e5861e8))
