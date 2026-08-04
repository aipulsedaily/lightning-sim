# Preset photographs

Every image bundled here is in the **public domain**. Four are works of
the U.S. National Oceanic and Atmospheric Administration and one of the
U.S. Fish and Wildlife Service; works of the United States federal
government carry no copyright, so there is no licence to comply with and
no attribution obligation.

They are credited anyway, because the people who stood in front of these
storms to take them deserve it, and because provenance should travel with
an asset rather than be reconstructed later.

All five were retrieved through Wikimedia Commons, whose licence metadata
was checked programmatically rather than assumed. Each has been cropped
where a stitching artefact required it, downscaled to at most 2400 pixels
across and re-encoded as JPEG; the originals are larger and are linked
below.

| File | Photograph | Credit | Source |
|---|---|---|---|
| `supercell-plains.jpg` | Supercell mesocyclone over the plains | Sean Waugh, NOAA/NSSL | [Commons](https://commons.wikimedia.org/wiki/File:Nssl0225_-_Flickr_-_NOAA_Photo_Library.jpg) |
| `wall-cloud-prairie.jpg` | Wall cloud over prairie | NOAA National Severe Storms Laboratory | [Commons](https://commons.wikimedia.org/wiki/File:Nssl0389_-_Flickr_-_NOAA_Photo_Library.jpg) |
| `shelf-cloud-panorama.jpg` | Shelf cloud over farmland, stitched panorama | NOAA National Severe Storms Laboratory | [Commons](https://commons.wikimedia.org/wiki/File:Nssl0392_-_Flickr_-_NOAA_Photo_Library.jpg) |
| `storm-chase.jpg` | NSSL chase vehicle beneath a wall cloud (VORTEX2) | Dr Mike Coniglio, NOAA/NSSL | [Commons](https://commons.wikimedia.org/wiki/File:Nssl0310_-_Flickr_-_NOAA_Photo_Library.jpg) |
| `klamath-marsh.jpg` | Cumulonimbus over Klamath Basin | U.S. Fish and Wildlife Service | [Commons](https://commons.wikimedia.org/wiki/File:Klamath_Basin_landscape.jpg) |

## Adding your own

`photos.json` is the whole list. Drop a JPEG in this folder, add an entry,
and it appears in the strip — no code to change:

```json
{
  "file": "my-storm.jpg",
  "thumb": "my-storm-thumb.jpg",
  "label": "shown on the tile",
  "title": "shown in the tooltip and status line",
  "licence": "whatever it is",
  "credit": "whoever took it",
  "source": "where it came from",
  "hint": "what is interesting about this one"
}
```

`thumb` is optional; without it the full image is used for the tile, which
is wasteful but works. If you add anything that is not public domain,
record its licence honestly here — that is what this file is for.
