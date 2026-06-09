import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RuntimeError, type MediaAsset } from "@mdcms/shared";

import { ThemeProvider } from "../../adapters/next-themes.js";
import { StudioNavigationProvider } from "../../navigation.js";
import {
  AdminCapabilitiesProvider,
  type AdminCapabilitiesValue,
} from "./capabilities-context.js";
import {
  StudioMountInfoProvider,
  type StudioMountInfo,
} from "./mount-info-context.js";
import { StudioSessionProvider } from "./session-context.js";
import MediaPage, {
  MEDIA_LIBRARY_PAGE_SIZE,
  MediaLibraryPageView,
  copyMediaAssetUrlToClipboard,
  createMediaLibraryAuthCacheKey,
  createMediaLibraryQueryKey,
  createMediaLibraryTargetKey,
  resolveMediaLibraryEffectiveOffset,
  type MediaLibraryPageState,
} from "./media-page.js";
import type {
  MediaLibraryFilters,
  MediaLibrarySortOption,
} from "./media-library-model.js";
import type { UserWithGrants } from "../../../users-api.js";

const API_BASE_URL = "https://api.example.com";

const defaultFilters: MediaLibraryFilters = {
  q: "",
  category: "all",
  uploadedBy: "",
  uploadedFrom: "",
  uploadedTo: "",
};

const heroAsset: MediaAsset = {
  id: "asset_hero",
  project: "marketing-site",
  filename: "hero.png",
  mimeType: "image/png",
  sizeBytes: 1536,
  url: "https://cdn.example.com/media/hero.png",
  uploadedBy: "user_123",
  uploadedAt: "2026-06-05T12:00:00.000Z",
};

const videoAsset: MediaAsset = {
  id: "asset_demo_video",
  project: "marketing-site",
  filename: "demo.mp4",
  mimeType: "video/mp4",
  sizeBytes: 8_388_608,
  url: "https://cdn.example.com/media/demo.mp4",
  uploadedBy: "user_123",
  uploadedAt: "2026-06-05T12:05:00.000Z",
};

const audioAsset: MediaAsset = {
  id: "asset_theme_audio",
  project: "marketing-site",
  filename: "theme.mp3",
  mimeType: "audio/mpeg",
  sizeBytes: 2_097_152,
  url: "https://cdn.example.com/media/theme.mp3",
  uploadedBy: "user_456",
  uploadedAt: "2026-06-05T12:10:00.000Z",
};

const mediaUsers: UserWithGrants[] = [
  {
    id: "user_123",
    name: "Maciej K.",
    email: "maciej@example.com",
    image: null,
    createdAt: "2026-06-01T12:00:00.000Z",
    grants: [],
  },
  {
    id: "user_456",
    name: "Ada P.",
    email: "ada@example.com",
    image: null,
    createdAt: "2026-06-01T12:00:00.000Z",
    grants: [],
  },
];

type FetchSpy = typeof fetch & {
  calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }>;
};

function createFetchSpy(response: Response): FetchSpy {
  const calls: FetchSpy["calls"] = [];
  const fetcher = (async (input, init) => {
    calls.push({ input, init });
    return response;
  }) as FetchSpy;
  fetcher.calls = calls;
  return fetcher;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderWithProviders(input: {
  queryClient?: QueryClient;
  capabilities?: Partial<AdminCapabilitiesValue>;
  mountInfo?: Partial<StudioMountInfo>;
}): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: input.queryClient ?? createQueryClient() },
      createElement(
        ThemeProvider,
        null,
        createElement(
          StudioNavigationProvider,
          {
            value: {
              pathname: "/admin/media",
              params: {},
              basePath: "/admin",
              push: () => {},
              replace: () => {},
              back: () => {},
            },
          },
          createElement(
            AdminCapabilitiesProvider,
            {
              value: {
                canReadSchema: true,
                canCreateContent: false,
                canPublishContent: false,
                canUnpublishContent: false,
                canDeleteContent: false,
                canManageUsers: false,
                canManageSettings: false,
                canReadMedia: true,
                canUploadMedia: false,
                canDeleteMedia: false,
                ...input.capabilities,
              },
            },
            createElement(
              StudioSessionProvider,
              {
                value: {
                  status: "authenticated",
                  csrfToken: "test-csrf-token",
                  session: {
                    id: "session_123",
                    userId: "user_123",
                    email: "demo@mdcms.local",
                    issuedAt: "2026-06-08T12:00:00.000Z",
                    expiresAt: "2026-06-08T13:00:00.000Z",
                  },
                },
              },
              createElement(
                StudioMountInfoProvider,
                {
                  value: {
                    project: "marketing-site",
                    environment: "production",
                    apiBaseUrl: API_BASE_URL,
                    auth: { mode: "cookie" as const },
                    environments: [],
                    hostBridge: null,
                    setEnvironment: () => {},
                    ...input.mountInfo,
                  },
                },
                createElement(MediaPage),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function renderView(input: {
  state: MediaLibraryPageState;
  filters?: MediaLibraryFilters;
  sort?: MediaLibrarySortOption;
}): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      null,
      createElement(
        StudioMountInfoProvider,
        {
          value: {
            project: "marketing-site",
            environment: "production",
            apiBaseUrl: API_BASE_URL,
            auth: { mode: "cookie" as const },
            environments: [],
            hostBridge: null,
            setEnvironment: () => {},
          },
        },
        createElement(MediaLibraryPageView, {
          state: input.state,
          canUploadMedia: false,
          uploadState: { status: "idle" },
          filters: input.filters ?? defaultFilters,
          searchInput: input.filters?.q ?? defaultFilters.q,
          sort: input.sort ?? "newest",
          onUploadFiles: () => {},
          onSearchInputChange: () => {},
          onFilterChange: () => {},
          onSortChange: () => {},
          onPageChange: () => {},
          onRetry: () => {},
          onCopyUrl: () => {},
        }),
      ),
    ),
  );
}

test("MediaPage renders forbidden state without issuing a media list request when canReadMedia is false", () => {
  const originalFetch = globalThis.fetch;
  const fetcher = createFetchSpy(new Response(JSON.stringify({ data: [] })));
  globalThis.fetch = fetcher;

  try {
    const markup = renderWithProviders({
      capabilities: { canReadMedia: false },
    });

    assert.match(markup, /data-mdcms-media-library-state="forbidden"/);
    assert.match(markup, /Access denied/);
    assert.equal(fetcher.calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MediaPage renders unavailable state without issuing a media list request when API config is missing", () => {
  const originalFetch = globalThis.fetch;
  const fetcher = createFetchSpy(new Response(JSON.stringify({ data: [] })));
  globalThis.fetch = fetcher;

  try {
    const markup = renderWithProviders({
      capabilities: { canReadMedia: false },
      mountInfo: { project: null },
    });

    assert.match(markup, /data-mdcms-media-library-state="unavailable"/);
    assert.match(markup, /missing project, environment, or server URL/);
    assert.equal(fetcher.calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MediaPage renders loading state while the media list query is pending", () => {
  const markup = renderWithProviders({});

  assert.match(markup, /data-mdcms-media-library-state="loading"/);
  assert.match(markup, /Loading media assets/);
});

test("MediaPage renders empty state without active filters from a cached list response", () => {
  const queryClient = createQueryClient();
  queryClient.setQueryData(
    createMediaLibraryQueryKey({
      project: "marketing-site",
      environment: "production",
      serverUrl: API_BASE_URL,
      authMode: "cookie",
      authCacheKey: null,
      filters: defaultFilters,
      sort: "newest",
      offset: 0,
    }),
    {
      data: [],
      pagination: {
        total: 0,
        limit: MEDIA_LIBRARY_PAGE_SIZE,
        offset: 0,
        hasMore: false,
      },
    },
  );

  const markup = renderWithProviders({ queryClient });

  assert.match(markup, /data-mdcms-media-library-state="empty"/);
  assert.match(markup, /No media yet/);
  assert.match(markup, /Drop files here or use Upload media to add assets/);
});

test("MediaPage renders known media uploaders with user display names", () => {
  const queryClient = createQueryClient();
  queryClient.setQueryData(
    createMediaLibraryQueryKey({
      project: "marketing-site",
      environment: "production",
      serverUrl: API_BASE_URL,
      authMode: "cookie",
      authCacheKey: null,
      filters: defaultFilters,
      sort: "newest",
      offset: 0,
    }),
    {
      data: [heroAsset, audioAsset],
      pagination: {
        total: 2,
        limit: MEDIA_LIBRARY_PAGE_SIZE,
        offset: 0,
        hasMore: false,
      },
    },
  );
  queryClient.setQueryData(["users", API_BASE_URL], mediaUsers);

  const markup = renderWithProviders({
    queryClient,
    capabilities: { canManageUsers: true },
  });

  assert.match(markup, /Maciej K\./);
  assert.match(markup, /Ada P\./);
  assert.match(markup, /MK/);
  assert.match(markup, /AP/);
  assert.doesNotMatch(markup, />user_123</);
  assert.doesNotMatch(markup, />user_456</);
});

test("media library query helpers scope token auth and reset stale target offsets", () => {
  const productionTarget = createMediaLibraryTargetKey({
    project: "marketing-site",
    environment: "production",
    serverUrl: API_BASE_URL,
  });
  const stagingTarget = createMediaLibraryTargetKey({
    project: "marketing-site",
    environment: "staging",
    serverUrl: API_BASE_URL,
  });

  assert.equal(
    resolveMediaLibraryEffectiveOffset(productionTarget, {
      targetKey: productionTarget,
      offset: 60,
    }),
    60,
  );
  assert.equal(
    resolveMediaLibraryEffectiveOffset(stagingTarget, {
      targetKey: productionTarget,
      offset: 60,
    }),
    0,
  );
  assert.equal(
    createMediaLibraryAuthCacheKey({
      mode: "token",
      token: "mdcms_key_a",
    }),
    "mdcms_key_a",
  );
  assert.equal(createMediaLibraryAuthCacheKey({ mode: "cookie" }), null);

  assert.notDeepEqual(
    createMediaLibraryQueryKey({
      project: "marketing-site",
      environment: "production",
      serverUrl: API_BASE_URL,
      authMode: "token",
      authCacheKey: "mdcms_key_a",
      filters: defaultFilters,
      sort: "newest",
      offset: 0,
    }),
    createMediaLibraryQueryKey({
      project: "marketing-site",
      environment: "production",
      serverUrl: API_BASE_URL,
      authMode: "token",
      authCacheKey: "mdcms_key_b",
      filters: defaultFilters,
      sort: "newest",
      offset: 0,
    }),
  );
});

test("MediaLibraryPageView renders no-match state with active filters", () => {
  const markup = renderView({
    filters: { ...defaultFilters, q: "hero" },
    state: {
      status: "no-match",
      assets: [],
      pagination: {
        total: 0,
        limit: MEDIA_LIBRARY_PAGE_SIZE,
        offset: 0,
        hasMore: false,
      },
    },
  });

  assert.match(markup, /data-mdcms-media-library-state="no-match"/);
  assert.match(markup, /No media matches/);
  assert.match(markup, /Try changing the search or filters/);
});

test("MediaPage renders error state with retry action for media list failures", async () => {
  const queryClient = createQueryClient();
  await queryClient.prefetchQuery({
    queryKey: createMediaLibraryQueryKey({
      project: "marketing-site",
      environment: "production",
      serverUrl: API_BASE_URL,
      authMode: "cookie",
      authCacheKey: null,
      filters: defaultFilters,
      sort: "newest",
      offset: 0,
    }),
    queryFn: async () => {
      throw new RuntimeError({
        code: "MEDIA_LIBRARY_REQUEST_FAILED",
        message: "Media library request failed.",
        statusCode: 500,
      });
    },
  });

  const markup = renderWithProviders({ queryClient });

  assert.match(markup, /data-mdcms-media-library-state="error"/);
  assert.match(markup, /Failed to load media library/);
  assert.match(markup, /Media library request failed/);
  assert.match(markup, />Retry</);
});

test("MediaLibraryPageView renders the locked gallery layout, collapsed filters, sort, inline previews, and asset details", () => {
  const markup = renderView({
    state: {
      status: "ready",
      assets: [heroAsset, videoAsset, audioAsset],
      pagination: {
        total: 3,
        limit: MEDIA_LIBRARY_PAGE_SIZE,
        offset: 0,
        hasMore: false,
      },
    },
  });

  assert.match(markup, /data-mdcms-media-library-state="ready"/);
  assert.match(markup, /data-mdcms-media-library-layout="gallery"/);
  assert.doesNotMatch(markup, /Read-only/);
  assert.match(markup, /Search media/);
  assert.match(markup, /3 assets/);
  assert.match(markup, />Filters</);
  assert.match(markup, /Sort: Recent/);
  assert.doesNotMatch(markup, /Filter by media category/);
  assert.doesNotMatch(markup, /Filter by uploader/);
  assert.doesNotMatch(markup, /Uploaded from/);
  assert.doesNotMatch(markup, /Uploaded to/);
  assert.doesNotMatch(markup, /GRID/);
  assert.doesNotMatch(markup, /LIST/);
  assert.doesNotMatch(markup, /Upload media/);
  assert.match(markup, /hero\.png/);
  assert.match(markup, /image\/png/);
  assert.match(markup, /Image/);
  assert.match(
    markup,
    /<img[^>]+src="https:\/\/cdn\.example\.com\/media\/hero\.png"/,
  );
  assert.match(markup, /<video[^>]+controls=""[^>]+preload="metadata"/);
  assert.match(
    markup,
    /<source[^>]+src="https:\/\/cdn\.example\.com\/media\/demo\.mp4"[^>]+type="video\/mp4"/,
  );
  assert.match(markup, /<audio[^>]+controls=""[^>]+preload="metadata"/);
  assert.match(
    markup,
    /<source[^>]+src="https:\/\/cdn\.example\.com\/media\/theme\.mp3"[^>]+type="audio\/mpeg"/,
  );
  assert.match(markup, /1\.5 KB/);
  assert.match(markup, /user_123/);
  assert.match(markup, /Jun 5, 2026/);
  assert.match(markup, /Open asset hero\.png/);
  assert.match(markup, /Copy asset URL for hero\.png/);
  assert.match(markup, /aria-label="Asset details"/);
  assert.match(markup, /Asset details/);
  assert.match(markup, /asset_hero/);
  assert.doesNotMatch(markup, /filename search only/);
  assert.doesNotMatch(markup, /simple metadata filters only/);
  assert.doesNotMatch(markup, /no advanced organization features/);
  assert.doesNotMatch(markup, /Storage/);
  assert.doesNotMatch(markup, /Images<\/span>.*Videos<\/span>/s);
  assert.doesNotMatch(markup, /Used in/);
  assert.doesNotMatch(markup, /Alt text/);
  assert.doesNotMatch(markup, /Tags/);
  assert.doesNotMatch(markup, />Delete</);
  assert.doesNotMatch(markup, />Bulk</);
});

test("MediaLibraryPageView renders upload controls and progress when media upload is allowed", () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      null,
      createElement(MediaLibraryPageView, {
        state: {
          status: "ready",
          assets: [heroAsset],
          pagination: {
            total: 1,
            limit: MEDIA_LIBRARY_PAGE_SIZE,
            offset: 0,
            hasMore: false,
          },
        },
        canUploadMedia: true,
        uploadState: {
          status: "uploading",
          completedFiles: 1,
          totalFiles: 2,
        },
        filters: defaultFilters,
        searchInput: defaultFilters.q,
        sort: "newest",
        onUploadFiles: () => {},
        onSearchInputChange: () => {},
        onFilterChange: () => {},
        onSortChange: () => {},
        onPageChange: () => {},
        onRetry: () => {},
        onCopyUrl: () => {},
      }),
    ),
  );

  assert.match(markup, />Upload</);
  assert.match(markup, /data-mdcms-media-upload-progress="docked"/);
  assert.match(markup, /Uploading media 1 of 2/);
  assert.match(markup, /role="progressbar"/);
  assert.match(markup, /aria-valuemax="2"/);
  assert.match(markup, /aria-valuenow="1"/);
});

test("MediaLibraryPageView renders pagination actions as buttons", () => {
  const markup = renderView({
    state: {
      status: "ready",
      assets: [heroAsset],
      pagination: {
        total: 91,
        limit: MEDIA_LIBRARY_PAGE_SIZE,
        offset: 30,
        hasMore: true,
      },
    },
  });

  assert.match(markup, /<button[^>]+aria-label="Go to previous page"/);
  assert.match(markup, /<button[^>]+aria-label="Go to page 2"/);
  assert.match(markup, /<button[^>]+aria-label="Go to next page"/);
  assert.doesNotMatch(markup, /<a[^>]+aria-label="Go to previous page"/);
});

test("copyMediaAssetUrlToClipboard falls back when Clipboard API is unavailable", async () => {
  const copied: string[] = [];
  const originalClipboard = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard",
  );
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const textArea = {
    value: "",
    style: {},
    setAttribute() {},
    select() {
      copied.push(this.value);
    },
  };

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: {
        appendChild() {},
        removeChild() {},
      },
      createElement(tagName: string) {
        assert.equal(tagName, "textarea");
        return textArea;
      },
      execCommand(command: string) {
        assert.equal(command, "copy");
        return true;
      },
      getSelection() {
        return null;
      },
    },
  });

  try {
    await copyMediaAssetUrlToClipboard("https://cdn.example.com/hero.png");
  } finally {
    if (originalClipboard) {
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  }

  assert.deepEqual(copied, ["https://cdn.example.com/hero.png"]);
});
