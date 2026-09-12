# TuneJS requirements research

Research date: 2026-09-05. One-time public desk research; no interviews, outreach, or product benchmarks were conducted.

## Finding

The strongest recurring signal in this sample is demand for dependable, understandable audio workflows: getting sound to play, keeping timing stable, carrying a project across platforms, accessing live audio data, and making different tools work together.

For TuneJS, the opportunity is a coherent creative framework with reliable host integration, clear diagnostics, and composable features. This research supports that direction, but does not establish market size, willingness to adopt another framework, or superiority over existing libraries.

Spatial audio remains a first-class product requirement from the project owner. Public discussions provide useful spatial integration cases, but this sample does not establish that spatial audio is the most widely requested feature.

## Method and limits

- Searched public Reddit posts, X/Twitter indexing, GitHub issues, the Three.js forum, and official project documentation. Queries covered musical scheduling, mobile audio, recording/streaming, spatial sound, exports, documentation, and platform compatibility.
- Retained 18 distinct discussion/report sources in the evidence register below. Most dated examples are from 2025–2026; older 2019–2023 reports are explicitly historical. This is a purposive qualitative sample, not a representative survey or frequency census.
- Reddit content was often available as substantial indexed post/comment excerpts even when direct opening failed. The register distinguishes **page** access from **indexed** access. Indexed sources establish only what the retrieved passage says; replies, resolutions, and current status may be missing.
- X searches included `site:x.com "Tonejs"`, `site:x.com "web audio" "wish"`, and Twitter/WebAudio/latency variants. No relevant individual post could be verified. Direct public X search also failed to load. **There are no X-derived findings in this report.** This is an access/coverage gap, not evidence of absent demand.
- Cross-posts of the same project were counted once. Creator announcements are labeled separately from requests. Votes, promotional claims, and commenters' technical explanations were not treated as validated performance evidence.
- Compared historical complaints with current official documentation. An old issue is evidence of a workflow that caused difficulty, not proof that a current library still lacks the feature.
- A 2021 W3C survey PDF was located, but chart labels/open responses were not reliably retrievable and screenshots failed. It is excluded from the evidence synthesis; no survey percentages are claimed.

## Requirements inferred from the evidence

Priority below is our recommendation, not a ranking supplied by respondents. **P0** means foundational validation/contract; **P1** means a focused feature or integration; **P2** means a later specialist extension. Confidence describes the signal in this sample, not market prevalence.

| ID | User need | Evidence and confidence | TuneJS requirement | Priority |
| --- | --- | --- | --- | --- |
| R01 | Sound should actually play, including after leaving and returning to an app | E01, E02, E04; corroborated reports across different contexts | Activation/recovery guidance, explicit session state, physical-device lifecycle tests, and a user-initiated audio test. Never equate a running engine state with proof of audible output. | P0 |
| R02 | Rhythms and interactions should remain responsive under UI load | E03, E04, E18; repeated motivation, with creator claims treated cautiously | Audio-clock scheduling, documented latency/quality modes, late-event diagnostics, and realistic mobile stress fixtures. Make immediate interaction and scheduled playback separate use cases. | P0 |
| R03 | Reuse JavaScript skills across web and native without assembling incompatible packages | E03, E06, E17; repeated direct requests | One creative API, an exact tested host/version matrix, clean starter projects, and explicit backend capabilities. Evaluate existing native foundations before committing to a bespoke bridge. | P0 |
| R04 | Receive microphone samples continuously instead of waiting for a completed file | E05 and E04; direct request plus independent raw-capture complaint | Timestamped PCM chunk input/output with format metadata, bounded buffers, cancellation, and slow-consumer/overflow behavior. Keep network transport and AI providers in adapters. | P1; contract in P0 |
| R05 | Hear, see, and manipulate audio with smooth controls | E07, E08; two direct but distinct requests | Stable analysis/playhead data, UI-friendly subscriptions and polling, seek acknowledgements, and optional waveform/meter/scrubber examples. Rendering belongs outside the DSP core. | P1; data contract in P0 |
| R06 | Place and move sounds in a 3D experience without fighting coordinate or motion bugs | E09 plus E10 creator demonstration; narrow but concrete | Listener/source pose contracts, smooth motion, a Three.js adapter, explicit stereo/binaural modes, and movement/near-source regression fixtures. Preserve the existing early spatial roadmap. | P1; owner-required |
| R07 | Transform samples musically and combine specialized processing with the normal graph | E11 direct integration request; E10 creator demonstration; limited evidence of breadth | Sample regions, slicing, reverse, independent pitch/time control, and a supported custom-DSP integration path. Expose processing latency and quality tradeoffs; evaluate an existing algorithm. | P1 candidate |
| R08 | Finish and share a creation, including its assets | E15 creator workflow plus C05 official sharing limitation; moderate workflow evidence | Round-trip project examples, an asset manifest with missing-file diagnostics, and offline audio export. Local sample paths alone do not make a project portable. | P1 |
| R09 | Follow documentation that matches the installed package | E12 historical direct complaint; E06 compatibility friction; moderate | Versioned docs, tested examples against published artifacts, migration guidance, explicit stable/experimental labels, and package/host compatibility tables. | P0 |
| R10 | Background playback and device controls should survive production packaging | E13 and E14; separate user reports | Host media-session adapter, declared interruption/background policies, and lock-screen/remote-control tests in release builds. Browser availability is explicit. | P1; lifecycle contract in P0 |
| R11 | Use richer musical ideas without outgrowing a beginner API | E01 comments on tuplets and temperament; one discussion | Retain explicit frequency/cents and fractional-beat escape hatches; test triplets and non-default tuning. Expand musical helpers after dedicated musician validation. | P1 design constraint |
| R12 | Clean up recorded speech with a simple operation | E16; single direct request | An optional denoise/voice-processing extension using normal input/output contracts. Do not make an AI or speech stack mandatory for music users. | P2 |

## What this changes in our current draft

**Validate platform behavior before adding breadth.** The existing lifecycle and scheduling sections are justified, but “resume the engine” is too weak as an acceptance test. E02 describes silence despite an apparently running context and also contains a later report of a fix on an iOS beta. Test the versions we support; do not advertise a universal iOS defect or a universal framework workaround. [WebKit report](https://bugs.webkit.org/show_bug.cgi?id=291892)

**Add a continuous-audio contract.** Our recorder example only returns audio after stopping. That leaves out the explicit request to process or send microphone data as it arrives. Define raw PCM ingress/egress separately from file playback, encoded media streaming, and final recording export. The framework owns timing and buffering; optional adapters own WebSocket, WebRTC, and model-provider transport. [Microphone streaming request](https://www.reddit.com/r/reactnative/comments/1jpqpol)

**Promote visual feedback into the first example set.** A level analyzer is useful but does not fully address waveform discovery, playback progress, and responsive scrubbing. Add companion examples and a stable data interface rather than requiring a UI framework inside TuneJS. [Waveform request](https://www.reddit.com/r/reactnative/comments/1n1039f), [slider problems](https://www.reddit.com/r/reactnative/comments/1k55nm6)

**Make spatial integration the deliverable.** Position setters alone do not solve listener movement, world-transform conversion, and room-related workflows. Keep motion tests and the Three.js adapter early; keep advanced room simulation modular until separately validated. The available integration report is historical, so use it as a regression scenario rather than a claim about today's Three.js. [Spatial integration discussion](https://discourse.threejs.org/t/positional-audio-stuttering-using-omnitone-resonance-audio-sdk-ambisonics-libraries/37748)

**Add sample transformation to the candidate backlog.** Independent pitch/time control, slicing, and custom effects fit the creative promise but were underspecified. Evidence here is thinner than for reliability: a custom-effect request and a creator's project demonstrate a useful workflow, not broad demand for every transform. [Custom effect request](https://github.com/Tonejs/Tone.js/issues/583), [SHATTER creator demonstration](https://www.reddit.com/r/musiconcrete/comments/1udgff9/shatter_break_a_sound_into_pieces_and_play_them/)

**Document the production host, not just the API.** The current roadmap lacks a concrete media-session surface and release-build checks. The need remains useful even though current Expo documentation already covers background playback and lock-screen configuration. This points toward integration quality rather than claiming an unavailable capability. [Release-build report](https://www.reddit.com/r/expo/comments/1q0bcly/media_controls_work_in_expo_dev_build_but_not_in/), [current Expo Audio documentation](https://docs.expo.dev/versions/latest/sdk/audio/)

## Existing solutions we must account for

Official documentation establishes these capabilities; no comparative performance tests were run.

| ID | Existing project | Relevant coverage | Implication for TuneJS |
| --- | --- | --- | --- |
| C01 | [Tone.js](https://tonejs.github.io/) | Instruments, musical scheduling, effects, routing, and parameter signals | A synth/effect/transport wrapper is insufficient differentiation. Compare complete workflows and API clarity. |
| C02 | [React Native Audio API](https://docs.swmansion.com/react-native-audio-api/docs/category/fundamentals/) | A Web Audio-style approach targeting iOS, Android, and web; documentation includes recording, streaming, offline contexts, worklets, and system integration | Include it in the backend reuse experiment. Cross-platform JavaScript audio is not an empty category. Per-feature platform coverage still needs inspection. |
| C03 | [Expo Audio](https://docs.expo.dev/versions/latest/sdk/audio/) | Playback, recording, audio sessions, background configuration, and lock-screen controls | Old “no background controls” complaints cannot be repeated as current feature gaps. Aim for predictable setup, coexistence, and release testing. |
| C04 | [Strudel FAQ](https://strudel.cc/learn/faq/) and [REPL design](https://strudel.cc/technical-manual/repl/) | Live pattern manipulation, visual playback feedback, discoverable sounds, and a distinct pattern-oriented workflow | Learn from immediate creative exploration. Do not assume every user wants DAW-style arrangement or invent a notation before testing it. |
| C05 | [Strudel project updates](https://live.strudel.cc/blog/) | Local sample import, pattern sharing, and an explicit warning that another machine cannot load your local samples | Portable assets are part of sharing. Consider reusable project bundles or resolvers, not only serialized code. |
| C06 | [wavesurfer.js](https://wavesurfer.xyz/) | Interactive waveforms and plugins for regions, recording, envelopes, timelines, and spectrograms | Define interoperable analysis/transport interfaces and optional UI companions; avoid rebuilding every visualization in core. |
| C07 | [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) | An existing C++ pitch/time-processing library | Evaluate algorithm reuse and integration quality before writing a new time-stretch engine. No quality or latency superiority is established by this research. |

**Architectural implication:** add an explicit comparison of existing browser/native foundations against the proposed shared C++/WASM renderer. Public requests support a better developer experience; they do not select a programming language, require a new DSP implementation, or prove the proposed backend is preferable.

## Evidence register

Dates below describe the original post/report when available. “Indexed” means the retrieved search result included source text, but a complete discussion was not verified. Issues marked closed are retained only as historical workflow evidence.

| ID | Source and date | Type/access | Observed request or experience |
| --- | --- | --- | --- |
| E01 | [Music theory for programmers](https://www.reddit.com/r/programming/comments/1vtm44m/music_theory_for_programmers/), 2026-08-20 | Reddit comments; page and dated index | Multiple readers report silent iPhone demos; other comments request richer rhythm/tuning explanations and value approachable learning material. Technical statements in comments are not independently established. |
| E02 | [WebKit 291892](https://bugs.webkit.org/show_bug.cgi?id=291892), 2025-04-22; follow-up 2025-11-19 | Browser issue; page | PWA foreground recovery can leave sound silent despite resume/running state. Later commenter reports a fix on iOS 26.2 beta 3. Retrieved tracker status remains NEW; current-device behavior was not tested. |
| E03 | [Mobile app development with Web Audio](https://www.reddit.com/r/webdev/comments/1mnrfkh), 2025-08-11 | Direct request; indexed | Wants precise audio scheduling across platforms while retaining an existing React/TypeScript app. Replies speculate about implementation choices; those are not benchmark results. |
| E04 | [Web Audio issue 2632](https://github.com/WebAudio/web-audio-api/issues/2632), 2025-04-08 | Direct complaint; page; closed | Reports recording glitches and asks for easy raw recorded samples where minimum latency is unnecessary. The author's sweeping claim about all devices is not adopted here. |
| E05 | [Good library for microphone streaming](https://www.reddit.com/r/reactnative/comments/1jpqpol), 2025-04-02 | Direct request; indexed | Wants continuous microphone delivery to an external service; file-at-stop recording creates an unwanted turn-based experience. |
| E06 | [Reliable sound/music library for React Native New Architecture](https://www.reddit.com/r/reactnative/comments/1ktlmy4), 2025-05-23 | Direct request; indexed | Reports asset-loading and architecture compatibility trouble; another commenter reports successful use, so the evidence is not a universal failure claim. |
| E07 | [Which React Native library should be built?](https://www.reddit.com/r/reactnative/comments/1n1039f), 2025-08-26; waveform comment 2025-08-27 | Direct request; indexed | A commenter asks for live audio waveform support compatible with the new architecture. Later replies ask which form of “live” is intended. |
| E08 | [Any good library for an audio slider?](https://www.reddit.com/r/reactnative/comments/1k55nm6), 2025-04-22 | Direct request; indexed | Wants smooth Spotify-like scrubbing; reports frame drops and progress issues with multiple players. Root cause is not established. |
| E09 | [Positional audio stuttering](https://discourse.threejs.org/t/positional-audio-stuttering-using-omnitone-resonance-audio-sdk-ambisonics-libraries/37748), 2022-05-03; follow-ups in 2023 | Integration request/discussion; page | Moving the listener causes popping; another developer asks about multiple rooms. Follow-up describes coordinate conversion and an alternative library. |
| E10 | [SHATTER](https://www.reddit.com/r/musiconcrete/comments/1udgff9/shatter_break_a_sound_into_pieces_and_play_them/), 2026-06-23 | Creator promotion; indexed | Demonstrates a workflow combining slicing, looping, independent pitch/time, sequencing, and spatial placement. Cross-posts are one source; claims about quality/browser coverage were not tested. |
| E11 | [Tone.js custom effect issue 583](https://github.com/Tonejs/Tone.js/issues/583), 2019-11-22 | Direct integration request; indexed; closed | Developer has a WASM pitch/time effect and cannot see a clear path to integrating it into a Tone.js chain. Historical, not a current API audit. |
| E12 | [Tone.js version clarification issue 611](https://github.com/Tonejs/Tone.js/issues/611), 2020-01-21 | Direct documentation complaint; page; closed | Installed versions, next releases, and documentation versions are confusing while attempting offline work. Historical. |
| E13 | [Media notification and lock-screen controls](https://www.reddit.com/r/expo/comments/1nsh9p3/media_notification_and_lock_screen_controls/), 2025-09-28 | Creator account of an integration problem; indexed | Author built an adapter after problems combining playback and system controls. Current Expo functionality was checked separately. |
| E14 | [Controls work in development but not release](https://www.reddit.com/r/expo/comments/1q0bcly/media_controls_work_in_expo_dev_build_but_not_in/), exact date not verified | Direct bug/help request; page | Background audio works but notification/lock-screen controls disappear in a distributed Android release build. No verified resolution in retrieved content. |
| E15 | [Browser DAW development](https://www.reddit.com/r/AudioProgramming/comments/1jh41p2), 2025-03-22 | Creator experience; indexed | Author supports project import/export, wants creation/sharing, and reports mobile performance limits. This is workflow evidence, not independent product evaluation. |
| E16 | [Audio noise reduction in React Native](https://www.reddit.com/r/reactnative/comments/1i0nwac), 2025-01-13 | Direct request; indexed | Wants a simple record → denoise → play operation; one reply points to a possible implementation. |
| E17 | [React Native for a simplified DAW?](https://www.reddit.com/r/reactnative/comments/1i34rbb), 2025-01-17 | Direct request; indexed | Wants Android, iOS, browser, and possibly Electron; fears committing to tools that cannot support the intended product. |
| E18 | [Scheduled generative audio implementation notes](https://www.reddit.com/r/webaudio/comments/1w0r4ln/web_audio_implementation_notes_scheduling_a_live/), 2026-08-28 | Creator experience; indexed | Describes replacing timer-driven work, long lookahead, smooth parameter updates, and asset/CSP deployment details. Scheduling and no-glitch claims are unverified; a 24-second lookahead is not adopted as an interaction default. |

## Proposed validation tasks

These are next-step research/prototype tasks, not completed tests or authorization to contact people.

1. **First sound and recovery:** developers run a minimal instrument on desktop and physical phones, deliberately interrupt it, and recover using only public API/docs. Record time to first sound, unexpected silence, and time to diagnose.
2. **Creative combination:** build a sample-based rhythm, alter it live, move a source, and export the result. Compare code clarity and missing glue against existing tools, with the same task and assets.
3. **Continuous input:** record and inspect PCM while a deliberately slow consumer creates backpressure. Verify ordering, timestamps, bounded memory, cancellation, and clear overflow reporting.
4. **Native production path:** build an actual release artifact with background behavior and media controls on each claimed host. Development previews alone do not satisfy the task.
5. **Sharing:** open a saved creation in a clean environment, including missing assets and unavailable extensions. Measure whether the recipient can identify and fix the problem.
6. **Follow-up interviews:** seek web-audio developers, React Native audio developers, creative coders/musicians, and spatial/XR builders. Ask about the last blocked project, current workaround, migration costs, and what would justify another dependency. Obtain separate authorization before outreach.

The remaining demand questions are adoption cost, preferred API style, acceptable package/native-build overhead, the relative value of professional music features versus general playback, and whether spatial creators need basic positioning or room simulation first. Public X coverage also remains incomplete.
