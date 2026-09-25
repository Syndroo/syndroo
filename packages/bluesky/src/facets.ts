export interface BlueskyFacet {
  index: {
    byteStart: number;
    byteEnd: number;
  };
  features: Array<{
    $type: "app.bsky.richtext.facet#link";
    uri: string;
  }>;
}

/**
 * Builds link facets with UTF-8 byte offsets. Shared by the legacy remote
 * publisher and the local provider so both freeze the same record shape.
 */
export function createLinkFacets(content: string): BlueskyFacet[] {
  const encoder = new TextEncoder();
  const facets: BlueskyFacet[] = [];
  const pattern = /https?:\/\/[^\s<>"']+/gu;

  for (const match of content.matchAll(pattern)) {
    const matchedUrl = match[0];
    const uri = matchedUrl.replace(/[.,!?;:]+$/u, "");

    if (!uri || match.index === undefined) {
      continue;
    }

    try {
      new URL(uri);
    } catch {
      continue;
    }

    const byteStart = encoder.encode(content.slice(0, match.index)).byteLength;
    facets.push({
      index: {
        byteStart,
        byteEnd: byteStart + encoder.encode(uri).byteLength,
      },
      features: [
        {
          $type: "app.bsky.richtext.facet#link",
          uri,
        },
      ],
    });
  }

  return facets;
}
