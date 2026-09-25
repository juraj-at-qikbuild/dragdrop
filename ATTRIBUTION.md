# Attribution

## Map data

The game world is generated from OpenStreetMap:

> © OpenStreetMap contributors. Data is available under the Open Database License (ODbL) 1.0.
> https://www.openstreetmap.org/copyright

`public/data/bratislava.json` is a Derived Database of OpenStreetMap data and is also licensed under the ODbL. The attribution is shown in the game's main menu ("O hre") and on the full-screen map.

Heights of the buildings OpenStreetMap has no height for are derived from the number of floors in Bratislava's digital technical map (the "Podlažnosť" layer of the `tm/Stavby` service on geoportal.bratislava.sk, fetched by `scripts/fetch-heights.mjs`):

> Digitálna technická mapa hlavného mesta SR Bratislavy (©) Hlavné mesto SR Bratislava. Licensed under CC BY 4.0.
> https://creativecommons.org/licenses/by/4.0/

The game does not ship the city's data itself, only what is derived from it: each such building's number of storeys, the median floor count of the city's label points inside its footprint. This attribution is also shown in the main menu ("O hre").

## Artwork and audio

- Vehicles, pedestrians, trams, buildings, rooftop ads, UI and the UFO on Most SNP are drawn procedurally in code.
- `public/assets/erb.svg` is an original simplified emblem inspired by the Bratislava coat of arms. It is not a reproduction of the official arms.
- All sound effects and radio music are synthesised at runtime with the Web Audio API. The melodies are original.

## Brands

Every brand name, slogan and ad in the game is a parody: Kofolka, Strieborný Bažant, Slovnafta, Dolinky, Tatračaj, Billka, Starbáks, McDonaldov, KFČ and others. No real logos or trademarks are used. Real shops and fuel stations in the OSM data are shown only under their parody names.
