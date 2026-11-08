// SPDX-License-Identifier: MIT
// Meluli's local JSON-lines adapter for whisper.cpp. No network operations.
#include <whisper.h>
#include <limits>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#ifdef __APPLE__
#include <sys/resource.h>
#endif

using json = nlohmann::json;
namespace {
constexpr size_t kChunkSamples = 30 * 16000;
constexpr const char* kModelFile = "ggml-ivrit-whisper-large-v3-turbo-q8_0.bin";
std::mutex outputMutex;
std::atomic<bool> canceled{false};
std::atomic<bool> busy{false};
void emit(const json& value) { std::lock_guard<std::mutex> lock(outputMutex); std::cout << value.dump(-1, ' ', true) << std::endl; }
struct Canceled {};
struct InvalidOutput {};
void checkCanceled() { if (canceled.load()) throw Canceled{}; }
// Model text can hold invalid UTF-8. dump() would then throw inside emit(), outside
// the job's try block, and abort the worker. Reject it here; never repair or invent text.
void assertSerializable(const json& value) {
  try { (void)value.dump(); } catch (const json::type_error&) { throw InvalidOutput{}; }
}
// A call is hours of speech and one split letter must not lose all of it. Bytes that can still
// become a character wait for the next segment. Anything else is dropped. Dictation stays strict.
std::string repairUtf8(const std::string& input, std::string& carry) {
  const std::string bytes = carry + input; carry.clear();
  std::string output; output.reserve(bytes.size());
  for (size_t i = 0; i < bytes.size();) {
    const auto lead = static_cast<unsigned char>(bytes[i]);
    if (lead < 0x80) { output += bytes[i++]; continue; }
    const size_t length = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    if (length == 0) { i += 1; continue; }
    const int low = lead == 0xe0 ? 0xa0 : lead == 0xf0 ? 0x90 : 0x80;
    const int high = lead == 0xed ? 0x9f : lead == 0xf4 ? 0x8f : 0xbf;
    size_t have = 1;
    while (have < length && i + have < bytes.size()) {
      const int next = static_cast<unsigned char>(bytes[i + have]);
      if (next < (have == 1 ? low : 0x80) || next > (have == 1 ? high : 0xbf)) break;
      have += 1;
    }
    if (have == length) { output.append(bytes, i, length); i += length; }
    else if (i + have == bytes.size()) { carry = bytes.substr(i); break; }
    else i += 1;
  }
  return output;
}

// A letter split between two segments belongs to the word that ended the first. Takes the bytes
// that finish the carried letter from the start of `next`; empty when they do not make one.
std::string finishCarried(std::string& carry, std::string& next) {
  if (carry.empty()) return "";
  const auto lead = static_cast<unsigned char>(carry[0]);
  const size_t length = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
  if (length <= carry.size() || next.size() < length - carry.size()) return "";
  const size_t need = length - carry.size();
  std::string rest;
  const std::string letter = repairUtf8(carry + next.substr(0, need), rest);
  if (letter.size() != length || !rest.empty()) return "";
  carry.clear(); next.erase(0, need);
  return letter;
}

// Adds one segment's text. `open` says the last added segment ended inside a word whose
// letter is still carried, so that letter can go back to it.
void appendSegment(json& segments, std::string& text, std::string& carry, bool& open,
    std::string raw, bool repairText, double start, double end) {
  if (repairText && open) {
    const std::string letter = finishCarried(carry, raw);
    if (!letter.empty()) { text += letter; segments.back()["text"] = segments.back()["text"].get<std::string>() + letter; }
  }
  open = false;
  std::string part = repairText ? repairUtf8(raw, carry) : raw;
  const bool endsInWord = !part.empty() && part.back() != ' ' && part.back() != '\t';
  while (!part.empty() && (part.back() == ' ' || part.back() == '\t')) part.pop_back();
  if (part.empty()) return;
  if (!text.empty()) text += " "; text += part;
  segments.push_back({{"start", start}, {"end", end}, {"text", part}});
  open = endsInWord && !carry.empty();
}

// Convert WAV input through bounded chunks. The ASR runtime owns its PCM buffer.
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
        validFormat = encoding == 1 && channels == 1 && rate == 16000 && bits == 16;
      } else if (!std::memcmp(id, "data", 4)) {
        if (!validFormat || !bytes || bytes % 2) throw std::runtime_error("Expected 16 kHz mono PCM16 WAV.");
        remaining = bytes; duration = bytes / 32000.0; return;
      } else file.seekg(bytes, std::ios::cur);
      if (bytes % 2) file.seekg(1, std::ios::cur);
    }
    throw std::runtime_error("WAV has no audio data.");
  }
  std::vector<float> read() {
    const size_t count = std::min<size_t>(remaining / 2, kChunkSamples);
    std::vector<int16_t> pcm(count); file.read(reinterpret_cast<char*>(pcm.data()), count * 2);
    if (!file && count) throw std::runtime_error("Truncated WAV samples.");
    remaining -= uint32_t(count * 2);
    std::vector<float> audio; audio.reserve(count);
    for (int16_t sample : pcm) audio.push_back(sample / 32768.0f);
    return audio;
  }
};

struct WhisperDeleter { void operator()(whisper_context* value) const { if (value) whisper_free(value); } };
class Runtime {
  std::unique_ptr<whisper_context, WhisperDeleter> recognizer;
  std::string loadedPath;
  bool loadedGpu = true;
 public:
  void load(const std::string& directory, bool gpu) {
    const auto path = (std::filesystem::path(directory) / kModelFile).string();
    if (recognizer && loadedPath == path && loadedGpu == gpu) return;
    if (!std::filesystem::is_regular_file(path)) throw std::runtime_error("Local model is missing.");
    recognizer.reset();
    auto params = whisper_context_default_params();
    params.use_gpu = gpu; params.flash_attn = true;
    recognizer.reset(whisper_init_from_file_with_params(path.c_str(), params));
    if (!recognizer) throw std::runtime_error("Could not load the local ASR model.");
    loadedPath = path; loadedGpu = gpu;
  }

  /** Durations of the last transcription. Numbers only: this never carries text. */
  json timing() const {
    const std::unique_ptr<whisper_timings> timings(whisper_get_timings(recognizer.get()));
    if (!timings) return json::object();
    return {{"encodeMs", timings->encode_ms}, {"decodeMs", timings->decode_ms}, {"batchdMs", timings->batchd_ms}};
  }

  json transcribe(const std::string& path, const std::string& jobId, bool repairText) {
    WavReader reader(path);
    // whisper_full keeps utterance context across its own 30-second windows.
    // Allocate PCM once; convert from bounded input chunks without a second full WAV copy.
    const auto count = static_cast<uint64_t>(reader.duration * WHISPER_SAMPLE_RATE);
    if (count > static_cast<uint64_t>(std::numeric_limits<int>::max())) throw std::runtime_error("Audio file is too long.");
    std::vector<float> audio; audio.reserve(count);
    for (auto chunk = reader.read(); !chunk.empty(); chunk = reader.read()) {
      checkCanceled(); audio.insert(audio.end(), chunk.begin(), chunk.end());
    }
    checkCanceled();
    emit({{"type", "progress"}, {"jobId", jobId}, {"stage", "processing"}, {"audioDurationSec", reader.duration}});
    // Match the evaluated Preview configuration exactly: Hebrew, beam 1, 2 CPU
    // threads, Metal + flash attention, segment timestamps, no VAD prefilter.
    auto params = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
    params.language = "he"; params.detect_language = false; params.translate = false;
    params.print_progress = false; params.print_realtime = false; params.print_timestamps = false;
    params.no_timestamps = false; params.beam_search.beam_size = 1; params.n_threads = 2;
    params.abort_callback = [](void*) { return canceled.load(); };
    params.progress_callback = [](whisper_context*, whisper_state*, int progress, void* data) {
      emit({{"type", "progress"}, {"jobId", *static_cast<const std::string*>(data)}, {"stage", "processing"},
        {"progressRatio", std::clamp(progress / 100.0, 0.0, 0.999)}});
    };
    params.progress_callback_user_data = const_cast<std::string*>(&jobId);
    whisper_reset_timings(recognizer.get());
    const int status = whisper_full(recognizer.get(), params, audio.data(), static_cast<int>(audio.size()));
    checkCanceled();
    if (status != 0) throw std::runtime_error("Local ASR inference failed.");
    json segments = json::array(); std::string text; std::string carry; bool open = false;
    for (int i = 0; i < whisper_full_n_segments(recognizer.get()); ++i) {
      const char* value = whisper_full_get_segment_text(recognizer.get(), i);
      if (!value || !*value) continue;
      const double start = std::clamp(whisper_full_get_segment_t0(recognizer.get(), i) / 100.0, 0.0, reader.duration);
      const double end = std::clamp(whisper_full_get_segment_t1(recognizer.get(), i) / 100.0, start, reader.duration);
      appendSegment(segments, text, carry, open, value, repairText, start, end);
    }
    json result = {{"text", text}, {"language", "he"}, {"segments", segments}};
    assertSerializable(result);
    return result;
  }
};

}

int main(int argc, char** argv) {
  if (argc != 2 || std::string(argv[1]) != "serve") { std::cerr << "Usage: meluli-asr-worker serve\n"; return 2; }
  // Upstream diagnostics can contain local paths; JSON errors remain generic.
  whisper_log_set([](ggml_log_level, const char*, void*) {}, nullptr);
  // This child performs user-requested dictation even while another app is
  // frontmost. Give its disk reads STANDARD policy explicitly rather than
  // inheriting a background I/O classification. IMPORTANT UI I/O still wins;
  // CPU thread count and the five-minute idle shutdown are unchanged.
  const char* diskIoPolicy = "system-default";
#ifdef __APPLE__
  if (setiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_PROCESS, IOPOL_STANDARD) == 0) diskIoPolicy = "standard";
#endif
  Runtime runtime; std::thread worker; std::string activeJob;
  emit({{"type", "ready"}, {"protocolVersion", 2}, {"workerVersion", "meluli-whispercpp-1.9.5-utf8-guard2"}, {"backend", "whispercpp"},
    {"diskIoPolicy", diskIoPolicy}, {"capabilities", {{"vad", {{"supported", false}, {"mode", "none"}, {"requiresModelPath", false}}}}}});
  std::string line;
  while (std::getline(std::cin, line)) {
    std::string jobId;
    try {
      if (line.size() > 65536) throw std::runtime_error("Request too large.");
      const auto request = json::parse(line);
      const auto type = request.at("type").get<std::string>();
      jobId = request.value("jobId", std::string());
      if (type == "health") { emit({{"type", "health"}, {"ok", true}}); continue; }
      if (type == "cancel") { if (jobId == activeJob && busy.load()) canceled.store(true); continue; }
      if (type != "warmup" && type != "transcribe") throw std::runtime_error("Unsupported request.");
      if (jobId.empty() || jobId.size() > 128) throw std::runtime_error("Invalid job identifier.");
      if (busy.load()) throw std::runtime_error("Worker is busy.");
      if (worker.joinable()) worker.join();
      activeJob = jobId; canceled.store(false); busy.store(true);
      worker = std::thread([&, request, type, jobId] {
        json terminal;
        try {
          emit({{"type", "progress"}, {"jobId", jobId}, {"stage", "loading"}});
          const auto since = [](std::chrono::steady_clock::time_point at) {
            return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - at).count();
          };
          const auto loadStarted = std::chrono::steady_clock::now();
          runtime.load(request.at("modelPath").get<std::string>(), request.value("useGpu", true));
          const double modelLoadMs = since(loadStarted);
          checkCanceled();
          if (type == "warmup") terminal = {{"type", "warmed"}, {"jobId", jobId}};
          else {
            const auto startedAt = std::chrono::steady_clock::now();
            auto result = runtime.transcribe(request.at("wavPath").get<std::string>(), jobId, request.value("repairText", false));
            checkCanceled();
            auto timing = runtime.timing();
            timing["modelLoadMs"] = modelLoadMs; timing["inferenceMs"] = since(startedAt);
            terminal = {{"type", "result"}, {"jobId", jobId}, {"result", result}, {"timing", timing}};
          }
        } catch (const Canceled&) { terminal = {{"type", "canceled"}, {"jobId", jobId}}; }
        catch (const InvalidOutput&) { terminal = {{"type", "error"}, {"jobId", jobId}, {"code", "invalid_utf8"}, {"message", "ASR returned invalid Unicode. No text was inserted."}}; }
        catch (const std::exception&) { terminal = {{"type", "error"}, {"jobId", jobId}, {"message", "Local transcription failed. Check the model and audio file."}}; }
        busy.store(false);
        emit(terminal);
      });
    } catch (const std::exception&) { emit({{"type", "error"}, {"jobId", jobId}, {"message", "Invalid or conflicting worker request."}}); }
  }
  canceled.store(true); if (worker.joinable()) worker.join();
  return 0;
}
