// SPDX-License-Identifier: MIT
// Meluli's local JSON-lines adapter for a streaming sherpa-onnx transducer (zipformer2). No network operations.
//
// Two kinds of work share one prewarmed recognizer:
// - a live dictation session: ordered audio chunks arrive while the person speaks, the worker answers with
//   partial text and finalizes a segment at each natural pause, and only `finish` ends the session;
// - a file job (imports, calls, kept recordings): the same streaming decode over a WAV file.
// Everything that touches the recognizer runs on one decode thread, in the order the requests arrived.
#include <sherpa-onnx/c-api/c-api.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#ifdef __APPLE__
#include <pthread.h>
#include <sys/qos.h>
#include <sys/resource.h>
#endif

using json = nlohmann::json;
namespace {
constexpr int kRate = 16000;
constexpr int kProtocolVersion = 3;
constexpr const char* kWorkerVersion = "meluli-sherpa-onnx-1.12.30-stream1";
/** One request line: a second of audio is 32 KB of PCM16, 43 KB in base64. */
constexpr size_t kMaxLine = 256 * 1024;
/** Audio waiting for the decode thread. Past this the session is marked lost, never silently trimmed. */
constexpr int64_t kMaxQueuedSamples = 30LL * kRate;
/** Zeros fed after the last sample so the final 1.28 s chunk and its right context decode. */
constexpr double kDefaultTailSec = 1.0;
constexpr const char* kFiles[] = {"encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"};

std::mutex outputMutex;
void emit(const json& value) { std::lock_guard<std::mutex> lock(outputMutex); std::cout << value.dump(-1, ' ', true) << std::endl; }
double msSince(std::chrono::steady_clock::time_point at) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - at).count();
}
struct Canceled {};
struct InvalidOutput {};
// Text that cannot be serialized would throw inside emit(); reject it here and never repair or invent text.
void assertSerializable(const json& value) {
  try { (void)value.dump(); } catch (const json::type_error&) { throw InvalidOutput{}; }
}
std::string trim(std::string value) {
  const auto space = [](unsigned char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; };
  while (!value.empty() && space(value.back())) value.pop_back();
  size_t start = 0; while (start < value.size() && space(value[start])) ++start;
  return value.substr(start);
}

/** Strict base64 (RFC 4648, padded) of little-endian PCM16. */
std::vector<float> decodePcm(const std::string& text) {
  static int8_t table[256]; static bool built = false;
  if (!built) {
    std::fill(std::begin(table), std::end(table), int8_t(-1));
    const char* alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (int i = 0; i < 64; ++i) table[static_cast<unsigned char>(alphabet[i])] = int8_t(i);
    built = true;
  }
  if (text.empty() || text.size() % 4) throw std::runtime_error("Invalid audio encoding.");
  std::vector<uint8_t> bytes; bytes.reserve(text.size() / 4 * 3);
  for (size_t i = 0; i < text.size(); i += 4) {
    int v[4]; int pad = 0;
    for (int k = 0; k < 4; ++k) {
      const char c = text[i + k];
      if (c == '=') { if (i + 4 != text.size() || k < 2) throw std::runtime_error("Invalid audio encoding."); v[k] = 0; ++pad; continue; }
      if (pad) throw std::runtime_error("Invalid audio encoding.");
      v[k] = table[static_cast<unsigned char>(c)];
      if (v[k] < 0) throw std::runtime_error("Invalid audio encoding.");
    }
    const uint32_t n = (uint32_t(v[0]) << 18) | (uint32_t(v[1]) << 12) | (uint32_t(v[2]) << 6) | uint32_t(v[3]);
    bytes.push_back(uint8_t(n >> 16));
    if (pad < 2) bytes.push_back(uint8_t(n >> 8));
    if (pad < 1) bytes.push_back(uint8_t(n));
  }
  if (bytes.size() % 2) throw std::runtime_error("Invalid audio length.");
  std::vector<float> samples(bytes.size() / 2);
  for (size_t i = 0; i < samples.size(); ++i) {
    const int16_t value = int16_t(uint16_t(bytes[2 * i]) | (uint16_t(bytes[2 * i + 1]) << 8));
    samples[i] = value / 32768.0f;
  }
  return samples;
}

// 16 kHz mono PCM16 WAV, read in bounded blocks.
class WavReader {
  std::ifstream file;
  uint32_t remaining = 0;
 public:
  double duration = 0;
  explicit WavReader(const std::string& path) : file(path, std::ios::binary) {
    char header[12]; file.read(header, 12);
    if (!file || std::memcmp(header, "RIFF", 4) || std::memcmp(header + 8, "WAVE", 4)) throw std::runtime_error("Invalid WAV header.");
    bool validFormat = false;
    while (file) {
      char id[4]; uint32_t bytes = 0; file.read(id, 4); file.read(reinterpret_cast<char*>(&bytes), 4);
      if (!file) break;
      const auto position = file.tellg();
      if (position < 0 || uint64_t(position) + bytes > std::filesystem::file_size(path)) throw std::runtime_error("Truncated WAV file.");
      if (!std::memcmp(id, "fmt ", 4)) {
        if (bytes < 16 || bytes > 4096) throw std::runtime_error("Invalid WAV format.");
        std::vector<char> format(bytes); file.read(format.data(), bytes);
        uint16_t encoding, channels, bits; uint32_t rate;
        std::memcpy(&encoding, format.data(), 2); std::memcpy(&channels, format.data() + 2, 2);
        std::memcpy(&rate, format.data() + 4, 4); std::memcpy(&bits, format.data() + 14, 2);
        validFormat = encoding == 1 && channels == 1 && rate == kRate && bits == 16;
      } else if (!std::memcmp(id, "data", 4)) {
        if (!validFormat || !bytes || bytes % 2) throw std::runtime_error("Expected 16 kHz mono PCM16 WAV.");
        remaining = bytes; duration = bytes / 32000.0; return;
      } else file.seekg(bytes, std::ios::cur);
      if (bytes % 2) file.seekg(1, std::ios::cur);
    }
    throw std::runtime_error("WAV has no audio data.");
  }
  std::vector<float> read(size_t maxSamples) {
    const size_t count = std::min<size_t>(remaining / 2, maxSamples);
    std::vector<int16_t> pcm(count); file.read(reinterpret_cast<char*>(pcm.data()), count * 2);
    if (!file && count) throw std::runtime_error("Truncated WAV samples.");
    remaining -= uint32_t(count * 2);
    std::vector<float> audio(count);
    for (size_t i = 0; i < count; ++i) audio[i] = pcm[i] / 32768.0f;
    return audio;
  }
};

/** Endpointing, chosen on the Phase 4 corpus (docs/BENCHMARKS.md, streaming engine). */
struct DecodeOptions {
  int threads = 2;
  float rule1 = 2.4f;   // trailing silence with nothing decoded
  float rule2 = 1.2f;   // trailing silence after speech: the natural pause that finalizes a segment
  float rule3 = 45.0f;  // longest segment before a forced cut
  double tailSec = kDefaultTailSec;
  bool operator==(const DecodeOptions& o) const {
    return threads == o.threads && rule1 == o.rule1 && rule2 == o.rule2 && rule3 == o.rule3;
  }
};

DecodeOptions readOptions(const json& request) {
  DecodeOptions options;
  const auto clampF = [](double v, double lo, double hi) { return float(std::clamp(v, lo, hi)); };
  if (request.contains("threads")) options.threads = std::clamp(request.at("threads").get<int>(), 1, 8);
  if (request.contains("pauseSec")) options.rule2 = clampF(request.at("pauseSec").get<double>(), 0.3, 5.0);
  if (request.contains("idleSec")) options.rule1 = clampF(request.at("idleSec").get<double>(), 0.5, 30.0);
  if (request.contains("maxSegmentSec")) options.rule3 = clampF(request.at("maxSegmentSec").get<double>(), 5.0, 300.0);
  if (request.contains("tailSec")) options.tailSec = std::clamp(request.at("tailSec").get<double>(), 0.3, 3.0);
  return options;
}

/** The recognizer and the decode of one stream. Used only from the decode thread. */
class Recognizer {
  const SherpaOnnxOnlineRecognizer* recognizer = nullptr;
  std::string loadedPath;
  DecodeOptions loaded;
 public:
  ~Recognizer() { if (recognizer) SherpaOnnxDestroyOnlineRecognizer(recognizer); }
  const SherpaOnnxOnlineRecognizer* get() const { return recognizer; }

  void load(const std::string& directory, const DecodeOptions& options) {
    if (recognizer && loadedPath == directory && loaded == options) return;
    std::string paths[4];
    for (int i = 0; i < 4; ++i) {
      paths[i] = (std::filesystem::path(directory) / kFiles[i]).string();
      if (!std::filesystem::is_regular_file(paths[i])) throw std::runtime_error("Local model is missing.");
    }
    if (recognizer) { SherpaOnnxDestroyOnlineRecognizer(recognizer); recognizer = nullptr; }
    SherpaOnnxOnlineRecognizerConfig config;
    std::memset(&config, 0, sizeof(config));
    config.feat_config.sample_rate = kRate;
    config.feat_config.feature_dim = 80;
    config.model_config.transducer.encoder = paths[0].c_str();
    config.model_config.transducer.decoder = paths[1].c_str();
    config.model_config.transducer.joiner = paths[2].c_str();
    config.model_config.tokens = paths[3].c_str();
    config.model_config.num_threads = options.threads;
    config.model_config.provider = "cpu";
    config.model_config.model_type = "zipformer2";
    config.decoding_method = "greedy_search";
    config.max_active_paths = 4;
    config.enable_endpoint = 1;
    config.rule1_min_trailing_silence = options.rule1;
    config.rule2_min_trailing_silence = options.rule2;
    config.rule3_min_utterance_length = options.rule3;
    recognizer = SherpaOnnxCreateOnlineRecognizer(&config);
    if (!recognizer) throw std::runtime_error("Could not load the local ASR model.");
    loadedPath = directory; loaded = options;
    // First inference allocates ONNX Runtime's buffers; do it now, not in the first dictation.
    const SherpaOnnxOnlineStream* stream = SherpaOnnxCreateOnlineStream(recognizer);
    std::vector<float> silence(kRate * 2, 0.0f);
    SherpaOnnxOnlineStreamAcceptWaveform(stream, kRate, silence.data(), int32_t(silence.size()));
    SherpaOnnxOnlineStreamInputFinished(stream);
    while (SherpaOnnxIsOnlineStreamReady(recognizer, stream)) SherpaOnnxDecodeOnlineStream(recognizer, stream);
    SherpaOnnxDestroyOnlineStream(stream);
  }
};

/**
 * One stream with endpoint segmentation. Finalized segments are never revisited: the text the
 * person saw at a pause is the text that is pasted.
 */
class SegmentedStream {
  const SherpaOnnxOnlineRecognizer* recognizer;
  const SherpaOnnxOnlineStream* stream;
  int64_t samples = 0;          // samples accepted, excluding the tail
  int64_t segmentStart = 0;     // sample where the current segment began
  bool finished = false;
 public:
  json segments = json::array();
  std::string text;             // finalized segments joined
  explicit SegmentedStream(const SherpaOnnxOnlineRecognizer* r) : recognizer(r), stream(SherpaOnnxCreateOnlineStream(r)) {
    if (!stream) throw std::runtime_error("Could not open a stream.");
  }
  ~SegmentedStream() { SherpaOnnxDestroyOnlineStream(stream); }
  SegmentedStream(const SegmentedStream&) = delete;
  SegmentedStream& operator=(const SegmentedStream&) = delete;
  int64_t acceptedSamples() const { return samples; }

  std::string current() const {
    const SherpaOnnxOnlineRecognizerResult* result = SherpaOnnxGetOnlineStreamResult(recognizer, stream);
    std::string value = result && result->text ? result->text : "";
    SherpaOnnxDestroyOnlineRecognizerResult(result);
    return trim(value);
  }

  /** Closes the current segment. Returns its text, empty when it held no words. */
  std::string closeSegment(int64_t endSample) {
    std::string value = current();
    if (!value.empty()) {
      json segment = {{"index", segments.size()}, {"start", segmentStart / double(kRate)}, {"end", endSample / double(kRate)}, {"text", value}};
      assertSerializable(segment);
      segments.push_back(segment);
      if (!text.empty()) text += " ";
      text += value;
    }
    SherpaOnnxOnlineStreamReset(recognizer, stream);
    segmentStart = endSample;
    return value;
  }

  /** Feeds audio and decodes what is ready. Calls `onSegment` for every pause found inside it. */
  template <class OnSegment>
  void accept(const float* data, size_t count, OnSegment onSegment) {
    if (finished) throw std::runtime_error("Stream already finished.");
    // Endpoints are checked at the capture's own chunk size, so a pause is found within ~128 ms of the rule.
    constexpr size_t kStep = 2048;
    for (size_t offset = 0; offset < count; offset += kStep) {
      const size_t n = std::min(kStep, count - offset);
      SherpaOnnxOnlineStreamAcceptWaveform(stream, kRate, data + offset, int32_t(n));
      samples += int64_t(n);
      while (SherpaOnnxIsOnlineStreamReady(recognizer, stream)) SherpaOnnxDecodeOnlineStream(recognizer, stream);
      if (SherpaOnnxOnlineStreamIsEndpoint(recognizer, stream)) {
        const std::string value = closeSegment(samples);
        if (!value.empty()) onSegment(segments.back());
      }
    }
  }

  /** Flushes the last segment. After this no audio is accepted. */
  std::optional<json> finish(double tailSec) {
    if (finished) return std::nullopt;
    finished = true;
    std::vector<float> tail(size_t(tailSec * kRate), 0.0f);
    SherpaOnnxOnlineStreamAcceptWaveform(stream, kRate, tail.data(), int32_t(tail.size()));
    SherpaOnnxOnlineStreamInputFinished(stream);
    while (SherpaOnnxIsOnlineStreamReady(recognizer, stream)) SherpaOnnxDecodeOnlineStream(recognizer, stream);
    const std::string value = closeSegment(samples);
    if (value.empty()) return std::nullopt;
    return segments.back();
  }

  json result() const {
    json value = {{"text", text}, {"language", "he"}, {"segments", segments}};
    assertSerializable(value);
    return value;
  }
};

struct Command {
  std::string type, id;
  json request;
  std::vector<float> pcm;
  int64_t seq = -1;
};

/** Requests in arrival order, bounded by the audio they hold. */
class CommandQueue {
  std::mutex mutex;
  std::condition_variable ready;
  std::deque<Command> items;
  int64_t queuedSamples = 0;
  bool closed = false;
 public:
  /** False when the audio would overflow the bound; nothing is queued then. */
  bool push(Command command) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!command.pcm.empty() && queuedSamples + int64_t(command.pcm.size()) > kMaxQueuedSamples) return false;
    queuedSamples += int64_t(command.pcm.size());
    items.push_back(std::move(command));
    ready.notify_one();
    return true;
  }
  std::optional<Command> pop() {
    std::unique_lock<std::mutex> lock(mutex);
    ready.wait(lock, [&] { return closed || !items.empty(); });
    if (items.empty()) return std::nullopt;
    Command command = std::move(items.front()); items.pop_front();
    queuedSamples -= int64_t(command.pcm.size());
    return command;
  }
  void close() { std::lock_guard<std::mutex> lock(mutex); closed = true; ready.notify_all(); }
};

/** Shared between the reader and the decode thread. */
struct Flags {
  std::mutex mutex;
  std::string canceledJob;      // file job to stop
  std::string canceledSession;  // live session to drop
  std::string lostSession;      // live session whose audio overflowed the queue
  bool jobCanceled(const std::string& id) { std::lock_guard<std::mutex> l(mutex); return canceledJob == "*" || (!id.empty() && canceledJob == id); }
  bool sessionCanceled(const std::string& id) { std::lock_guard<std::mutex> l(mutex); return !id.empty() && canceledSession == id; }
  bool sessionLost(const std::string& id) { std::lock_guard<std::mutex> l(mutex); return !id.empty() && lostSession == id; }
};

class Worker {
  Recognizer recognizer;
  Flags& flags;
  std::string modelPath;
  DecodeOptions options;
  // The live session. Only one person dictates at a time.
  std::string sessionId;
  std::unique_ptr<SegmentedStream> session;
  int64_t nextSeq = 0;
  std::string lastPartial;
  bool sessionBroken = false;
  std::chrono::steady_clock::time_point sessionStarted;

  void dropSession() { session.reset(); sessionId.clear(); nextSeq = 0; lastPartial.clear(); sessionBroken = false; }
  void failSession(const std::string& code, const std::string& message) {
    emit({{"type", "error"}, {"sessionId", sessionId}, {"code", code}, {"message", message}});
    sessionBroken = true;
  }

 public:
  explicit Worker(Flags& f) : flags(f) {}

  void ensureLoaded(const json& request) {
    // The open session's stream belongs to the loaded recognizer, so nothing reloads under it.
    if (session) return;
    const auto path = request.at("modelPath").get<std::string>();
    const DecodeOptions requested = readOptions(request);
    recognizer.load(path, requested);
    modelPath = path; options = requested;
  }

  void run(Command& c) {
    if (c.type == "warmup") {
      try {
        const auto started = std::chrono::steady_clock::now();
        ensureLoaded(c.request);
        emit({{"type", "warmed"}, {"jobId", c.id}, {"timing", {{"modelLoadMs", msSince(started)}}}});
      } catch (const std::exception&) { emit({{"type", "error"}, {"jobId", c.id}, {"message", "Could not load the local ASR model."}}); }
      return;
    }
    if (c.type == "transcribe") { transcribeFile(c); return; }
    if (c.type == "begin") {
      // The app starts a session only when the last one is over; one still open here was abandoned.
      if (session) { const std::string previous = sessionId; dropSession(); emit({{"type", "canceled"}, {"sessionId", previous}}); }
      try {
        ensureLoaded(c.request);
        sessionId = c.id; session = std::make_unique<SegmentedStream>(recognizer.get());
        nextSeq = 0; lastPartial.clear(); sessionBroken = false; sessionStarted = std::chrono::steady_clock::now();
        emit({{"type", "begun"}, {"sessionId", sessionId}});
      } catch (const std::exception&) {
        dropSession();
        emit({{"type", "error"}, {"sessionId", c.id}, {"code", "load_failed"}, {"message", "Could not load the local ASR model."}});
      }
      return;
    }
    // Every other request belongs to the open session; requests for any other id are stale.
    if (!session || c.id != sessionId) return;
    if (flags.sessionCanceled(c.id)) { dropSession(); emit({{"type", "canceled"}, {"sessionId", c.id}}); return; }
    if (c.type == "cancel") { dropSession(); emit({{"type", "canceled"}, {"sessionId", c.id}}); return; }
    if (flags.sessionLost(c.id) && !sessionBroken) failSession("backpressure", "Live audio fell behind; the recording is decoded in full at stop.");
    if (c.type == "audio") {
      if (sessionBroken) return;
      if (c.seq != nextSeq) { failSession("sequence", "Live audio arrived out of order."); return; }
      ++nextSeq;
      try {
        session->accept(c.pcm.data(), c.pcm.size(), [&](const json& segment) {
          emit({{"type", "segment"}, {"sessionId", sessionId}, {"segment", segment}});
          lastPartial.clear();
        });
        const std::string partial = session->current();
        if (partial != lastPartial) {
          lastPartial = partial;
          json message = {{"type", "partial"}, {"sessionId", sessionId}, {"seq", c.seq}, {"text", partial},
            {"segments", session->segments.size()}};
          assertSerializable(message);
          emit(message);
        }
      } catch (const InvalidOutput&) { failSession("invalid_utf8", "ASR returned invalid Unicode."); }
      catch (const std::exception&) { failSession("decode_failed", "Live decoding failed."); }
      return;
    }
    if (c.type == "finish") {
      const auto started = std::chrono::steady_clock::now();
      const int64_t expected = c.request.value("samples", int64_t(-1));
      json terminal;
      if (sessionBroken) terminal = {{"type", "error"}, {"sessionId", sessionId}, {"code", "session_lost"}, {"message", "Live session was lost."}};
      else if (expected >= 0 && expected != session->acceptedSamples()) {
        terminal = {{"type", "error"}, {"sessionId", sessionId}, {"code", "sample_mismatch"}, {"message", "Live audio does not match the recording."}};
      } else {
        try {
          if (auto segment = session->finish(c.request.contains("tailSec") ? readOptions(c.request).tailSec : options.tailSec)) {
            emit({{"type", "segment"}, {"sessionId", sessionId}, {"segment", *segment}});
          }
          terminal = {{"type", "final"}, {"sessionId", sessionId}, {"result", session->result()},
            {"timing", {{"finishMs", msSince(started)}, {"sessionMs", msSince(sessionStarted)}, {"samples", session->acceptedSamples()}}}};
        } catch (const InvalidOutput&) {
          terminal = {{"type", "error"}, {"sessionId", sessionId}, {"code", "invalid_utf8"}, {"message", "ASR returned invalid Unicode."}};
        } catch (const std::exception&) {
          terminal = {{"type", "error"}, {"sessionId", sessionId}, {"code", "decode_failed"}, {"message", "Live decoding failed."}};
        }
      }
      dropSession();
      emit(terminal);
    }
  }

  void transcribeFile(Command& c) {
    const std::string jobId = c.id;
    json terminal;
    try {
      emit({{"type", "progress"}, {"jobId", jobId}, {"stage", "loading"}});
      const auto loadStarted = std::chrono::steady_clock::now();
      ensureLoaded(c.request);
      const double modelLoadMs = msSince(loadStarted);
      if (flags.jobCanceled(jobId)) throw Canceled{};
      const auto started = std::chrono::steady_clock::now();
      WavReader reader(c.request.at("wavPath").get<std::string>());
      emit({{"type", "progress"}, {"jobId", jobId}, {"stage", "processing"}, {"audioDurationSec", reader.duration}});
      SegmentedStream stream(recognizer.get());
      const double total = std::max(1.0, reader.duration * kRate);
      auto lastReport = std::chrono::steady_clock::now();
      for (auto block = reader.read(kRate); !block.empty(); block = reader.read(kRate)) {
        if (flags.jobCanceled(jobId)) throw Canceled{};
        stream.accept(block.data(), block.size(), [](const json&) {});
        if (msSince(lastReport) >= 500) {
          lastReport = std::chrono::steady_clock::now();
          emit({{"type", "progress"}, {"jobId", jobId}, {"stage", "processing"},
            {"progressRatio", std::clamp(stream.acceptedSamples() / total, 0.0, 0.999)}});
        }
      }
      stream.finish(options.tailSec);
      if (flags.jobCanceled(jobId)) throw Canceled{};
      terminal = {{"type", "result"}, {"jobId", jobId}, {"result", stream.result()},
        {"timing", {{"modelLoadMs", modelLoadMs}, {"inferenceMs", msSince(started)}}}};
    } catch (const Canceled&) { terminal = {{"type", "canceled"}, {"jobId", jobId}}; }
    catch (const InvalidOutput&) { terminal = {{"type", "error"}, {"jobId", jobId}, {"code", "invalid_utf8"}, {"message", "ASR returned invalid Unicode. No text was inserted."}}; }
    catch (const std::exception&) { terminal = {{"type", "error"}, {"jobId", jobId}, {"message", "Local transcription failed. Check the model and audio file."}}; }
    emit(terminal);
  }
};

bool validId(const std::string& id) { return !id.empty() && id.size() <= 128; }
}

int main(int argc, char** argv) {
  if (argc != 2 || std::string(argv[1]) != "serve") { std::cerr << "Usage: meluli-asr-worker serve\n"; return 2; }
  const char* diskIoPolicy = "system-default";
#ifdef __APPLE__
  if (setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS, IOPOL_STANDARD) == 0) diskIoPolicy = "standard";
#endif
  Flags flags; CommandQueue queue; Worker worker(flags);
  std::thread decoder([&] {
#ifdef __APPLE__
    // Dictation is work the person is waiting on, even with another app frontmost.
    pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED, 0);
#endif
    while (auto command = queue.pop()) worker.run(*command);
  });
  emit({{"type", "ready"}, {"protocolVersion", kProtocolVersion}, {"workerVersion", kWorkerVersion}, {"backend", "sherpa-onnx"},
    {"diskIoPolicy", diskIoPolicy},
    {"capabilities", {{"streaming", true}, {"vad", {{"supported", false}, {"mode", "none"}, {"requiresModelPath", false}}}}}});
  std::string line;
  while (std::getline(std::cin, line)) {
    std::string id; bool liveRequest = false;
    try {
      if (line.size() > kMaxLine) throw std::runtime_error("Request too large.");
      auto request = json::parse(line);
      const auto type = request.at("type").get<std::string>();
      if (type == "health") { emit({{"type", "health"}, {"ok", true}}); continue; }
      const bool live = type == "begin" || type == "audio" || type == "finish" || type == "cancel_session";
      liveRequest = live;
      id = live ? request.at("sessionId").get<std::string>() : request.value("jobId", std::string());
      if (!validId(id)) throw std::runtime_error("Invalid identifier.");
      if (type == "cancel") { std::lock_guard<std::mutex> l(flags.mutex); flags.canceledJob = id; continue; }
      if (type == "cancel_session") {
        { std::lock_guard<std::mutex> l(flags.mutex); flags.canceledSession = id; }
        Command command; command.type = "cancel"; command.id = id; queue.push(std::move(command));
        continue;
      }
      if (type != "warmup" && type != "transcribe" && !live) throw std::runtime_error("Unsupported request.");
      Command command; command.type = type; command.id = id;
      if (type == "audio") {
        command.seq = request.at("seq").get<int64_t>();
        command.pcm = decodePcm(request.at("pcm").get<std::string>());
        if (command.pcm.empty() || command.pcm.size() > size_t(4 * kRate)) throw std::runtime_error("Invalid audio chunk.");
      } else {
        command.request = std::move(request);
      }
      if (type == "begin") { std::lock_guard<std::mutex> l(flags.mutex); if (flags.canceledSession == id) flags.canceledSession.clear(); }
      if (type == "transcribe") { std::lock_guard<std::mutex> l(flags.mutex); if (flags.canceledJob == id) flags.canceledJob.clear(); }
      if (!queue.push(std::move(command))) {
        // The decode thread is more than the bound behind. Say so once; the app decodes the whole recording at stop.
        std::lock_guard<std::mutex> l(flags.mutex); flags.lostSession = id;
      }
    } catch (const std::exception&) {
      if (liveRequest && validId(id)) {
        // A chunk that cannot be read leaves a hole in the session; it is decoded in full at stop.
        { std::lock_guard<std::mutex> l(flags.mutex); flags.lostSession = id; }
        emit({{"type", "error"}, {"sessionId", id}, {"code", "invalid_request"}, {"message", "Invalid live request."}});
      } else emit({{"type", "error"}, {"jobId", id}, {"message", "Invalid or conflicting worker request."}});
    }
  }
  queue.close();
  { std::lock_guard<std::mutex> l(flags.mutex); flags.canceledJob = "*"; }
  decoder.join();
  return 0;
}
