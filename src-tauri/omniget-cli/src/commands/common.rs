use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use omniget_core::core::http_client;
use omniget_core::core::registry::PlatformRegistry;
use omniget_core::core::ytdlp;
use omniget_core::models::media::{DownloadOptions, MediaInfo};
use omniget_core::models::settings::ProxySettings;
use omniget_core::platforms::{
    BilibiliDownloader, BlueskyDownloader, DirectFileDownloader, DouyinDownloader,
    GenericYtdlpDownloader, InstagramDownloader, P2pDownloader, PinterestDownloader,
    PlatformDownloader, RedditDownloader, ThreadsDownloader, TikTokDownloader,
    TwitchClipsDownloader, TwitterDownloader, VimeoDownloader, YouTubeDownloader,
};
use tokio_util::sync::CancellationToken;

use crate::reporter;

pub fn init_cli_runtime(proxy: Option<&str>) -> Result<()> {
    init_cookie_provider();

    if let Some(proxy_url) = proxy {
        http_client::init_proxy(parse_proxy(proxy_url)?);
    } else {
        http_client::init_proxy(ProxySettings::default());
    }

    Ok(())
}

fn init_cookie_provider() {
    ytdlp::set_global_cookie_file_fn(|| {
        reporter::default_cookie_path().map(|path| path.to_string_lossy().to_string())
    });
}

fn parse_proxy(raw: &str) -> Result<ProxySettings> {
    let (scheme, rest) = raw
        .split_once("://")
        .ok_or_else(|| anyhow!("Proxy must include a scheme, e.g. http://127.0.0.1:7897"))?;

    let proxy_type = match scheme {
        "http" | "https" | "socks5" => scheme.to_string(),
        other => return Err(anyhow!("Unsupported proxy scheme: {}", other)),
    };

    let authority = rest.split('/').next().unwrap_or(rest);
    let (auth, host_port) = match authority.rsplit_once('@') {
        Some((auth, host_port)) => (Some(auth), host_port),
        None => (None, authority),
    };

    let (host, port) = host_port
        .rsplit_once(':')
        .ok_or_else(|| anyhow!("Proxy must include host and port, e.g. http://127.0.0.1:7897"))?;

    if host.is_empty() {
        return Err(anyhow!("Proxy host cannot be empty"));
    }

    let port = port
        .parse::<u16>()
        .with_context(|| format!("Invalid proxy port: {}", port))?;

    let (username, password) = match auth.and_then(|a| a.split_once(':')) {
        Some((u, p)) => (u.to_string(), p.to_string()),
        None => (String::new(), String::new()),
    };

    Ok(ProxySettings {
        enabled: true,
        proxy_type,
        host: host.to_string(),
        port,
        username,
        password,
    })
}

pub fn core_platform_registry() -> PlatformRegistry {
    let mut registry = PlatformRegistry::new();
    registry.register(Arc::new(InstagramDownloader::new()));
    registry.register(Arc::new(ThreadsDownloader::new()));
    registry.register(Arc::new(PinterestDownloader::new()));
    registry.register(Arc::new(TikTokDownloader::new()));
    registry.register(Arc::new(TwitchClipsDownloader::new()));
    registry.register(Arc::new(TwitterDownloader::new()));
    registry.register(Arc::new(BlueskyDownloader::new()));
    registry.register(Arc::new(RedditDownloader::new()));
    registry.register(Arc::new(YouTubeDownloader::new()));
    registry.register(Arc::new(VimeoDownloader::new()));
    registry.register(Arc::new(BilibiliDownloader::new()));
    registry.register(Arc::new(DouyinDownloader::new()));
    registry.register(Arc::new(P2pDownloader::new()));
    registry.register(Arc::new(DirectFileDownloader::new()));
    registry.register(Arc::new(GenericYtdlpDownloader::new()));
    registry
}

pub async fn resolve_media_info(
    registry: &PlatformRegistry,
    url: &str,
) -> Result<(Arc<dyn PlatformDownloader>, MediaInfo)> {
    let platform = registry
        .find_platform(url)
        .unwrap_or_else(|| Arc::new(GenericYtdlpDownloader::new()));

    match platform.get_media_info(url).await {
        Ok(info) => Ok((platform, info)),
        Err(primary_error)
            if platform.name() != "generic" && GenericYtdlpDownloader::new().can_handle(url) =>
        {
            let generic: Arc<dyn PlatformDownloader> = Arc::new(GenericYtdlpDownloader::new());
            match generic.get_media_info(url).await {
                Ok(info) => Ok((generic, info)),
                Err(fallback_error) => Err(fallback_error).with_context(|| {
                    format!(
                        "{} extractor failed first: {}; generic fallback also failed",
                        platform.name(),
                        primary_error
                    )
                }),
            }
        }
        Err(error) => Err(error),
    }
}

/// How `omniget download --format` is applied.
///
/// `mp4`, `mkv` and `webm` are containers. They stay in `format_id` because
/// every platform already forwards that field, and `download_video` turns
/// those three names into `--merge-output-format` instead of `-f`. The same
/// flag is also added to `merge_output_format` for callers that forward
/// `custom_ytdlp_args`. A real yt-dlp format id (`22`, `bv*+ba/b`) is left
/// untouched.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct FormatPreference {
    pub format_id: Option<String>,
    pub audio_format: Option<String>,
    pub merge_output_format: Option<String>,
}

pub(crate) fn format_preference(format: Option<&str>, audio_only: bool) -> FormatPreference {
    let raw = format.map(str::trim).filter(|value| !value.is_empty());
    let container = raw.and_then(|value| {
        let normalized = value.trim_start_matches('.').to_ascii_lowercase();
        matches!(normalized.as_str(), "mp4" | "mkv" | "webm").then_some(normalized)
    });

    if audio_only {
        let audio_format = raw.map(|value| match container.as_deref() {
            Some("webm") => "opus".to_string(),
            Some("mp4" | "mkv") => "m4a".to_string(),
            _ => value.to_string(),
        });
        return FormatPreference {
            format_id: None,
            audio_format,
            merge_output_format: None,
        };
    }

    match container {
        Some(container) => FormatPreference {
            format_id: Some(container.clone()),
            audio_format: None,
            merge_output_format: Some(container),
        },
        None => FormatPreference {
            format_id: raw.map(str::to_string),
            audio_format: None,
            merge_output_format: None,
        },
    }
}

pub fn download_options(
    output_dir: PathBuf,
    quality: Option<u32>,
    audio_only: bool,
    subs: Option<String>,
    format: Option<String>,
    ytdlp_path: Option<PathBuf>,
) -> DownloadOptions {
    let mut custom_ytdlp_args = Vec::new();
    let download_subtitles = subs.is_some();
    if let Some(lang) = subs {
        custom_ytdlp_args.push("--write-subs".to_string());
        custom_ytdlp_args.push("--sub-langs".to_string());
        custom_ytdlp_args.push(lang);
    }
    let preference = format_preference(format.as_deref(), audio_only);
    if let Some(container) = &preference.merge_output_format {
        custom_ytdlp_args.push("--merge-output-format".to_string());
        custom_ytdlp_args.push(container.clone());
    }

    DownloadOptions {
        quality: quality.map(|q| q.to_string()),
        output_dir,
        filename_template: None,
        download_subtitles,
        include_auto_subtitles: false,
        download_mode: audio_only.then(|| "audio".to_string()),
        audio_format: preference.audio_format,
        format_id: preference.format_id,
        referer: None,
        extra_headers: None,
        page_url: None,
        user_agent: None,
        cancel_token: CancellationToken::new(),
        concurrent_fragments: 4,
        ytdlp_path,
        torrent_listen_port: None,
        torrent_id_slot: None,
        custom_ytdlp_args: (!custom_ytdlp_args.is_empty()).then_some(custom_ytdlp_args),
        torrent_files: None,
        torrent_auto_trackers: true,
        torrent_upnp: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_container_is_a_merge_target_not_a_bare_selector() {
        let mkv = format_preference(Some("mkv"), false);
        assert_eq!(mkv.format_id.as_deref(), Some("mkv"));
        assert_eq!(mkv.merge_output_format.as_deref(), Some("mkv"));
        assert_eq!(mkv.audio_format, None);

        let webm = format_preference(Some(".WEBM"), false);
        assert_eq!(webm.merge_output_format.as_deref(), Some("webm"));

        let opts = download_options(
            PathBuf::from("/tmp/out"),
            None,
            false,
            Some("en".to_string()),
            Some("mp4".to_string()),
            None,
        );
        assert_eq!(opts.format_id.as_deref(), Some("mp4"));
        assert_eq!(
            opts.custom_ytdlp_args.as_deref(),
            Some(
                [
                    "--write-subs".to_string(),
                    "--sub-langs".to_string(),
                    "en".to_string(),
                    "--merge-output-format".to_string(),
                    "mp4".to_string(),
                ]
                .as_slice()
            )
        );
    }

    #[test]
    fn real_format_ids_stay_selectors() {
        let plan = format_preference(Some("22"), false);
        assert_eq!(plan.format_id.as_deref(), Some("22"));
        assert_eq!(plan.merge_output_format, None);

        let plan = format_preference(Some("bv*+ba/b"), false);
        assert_eq!(plan.format_id.as_deref(), Some("bv*+ba/b"));
        assert_eq!(plan.merge_output_format, None);
    }

    #[test]
    fn audio_only_maps_containers_to_codecs() {
        assert_eq!(
            format_preference(Some("mp4"), true).audio_format.as_deref(),
            Some("m4a")
        );
        assert_eq!(
            format_preference(Some("webm"), true)
                .audio_format
                .as_deref(),
            Some("opus")
        );
        assert_eq!(
            format_preference(Some("mkv"), true).audio_format.as_deref(),
            Some("m4a")
        );
        assert_eq!(
            format_preference(Some("mp3"), true).audio_format.as_deref(),
            Some("mp3")
        );
        assert_eq!(format_preference(Some("mp3"), true).format_id, None);
        assert_eq!(
            format_preference(Some("mp3"), true).merge_output_format,
            None
        );
    }
}
