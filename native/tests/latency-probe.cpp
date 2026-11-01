// SPDX-License-Identifier: MIT
// Offline latency probe for the dictation decode settings. Prints one JSON line per run:
// timings and segment boundaries only, never recognized text. Uses the local model.
//   meluli-latency-probe <model-file> <repeats> [--gap-ms N] [--qos default,user-initiated,user-interactive] <a.wav> [b.wav ...]
#include <whisper.h>
#include <nlohmann/json.hpp>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <pthread/qos.h>
#include <sstream>
#include <thread>
#include <string>
#include <vector>

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;
static double since(Clock::time_point start) { return std::chrono::duration<double, std::milli>(Clock::now() - start).count(); }

static std::vector<float> readWav(const std::string& path) {
  std::ifstream file(path, std::ios::binary);
  char header[12]; file.read(header, 12);
  while (file) {
    char id[4]; uint32_t bytes = 0; file.read(id, 4); file.read(reinterpret_cast<char*>(&bytes), 4);
    if (!file) break;
    if (!std::memcmp(id, "data", 4)) {
      std::vector<int16_t> pcm(bytes / 2); file.read(reinterpret_cast<char*>(pcm.data()), bytes);
      std::vector<float> audio; audio.reserve(pcm.size());
      for (int16_t sample : pcm) audio.push_back(sample / 32768.0f);
      return audio;
    }
    file.seekg(bytes + (bytes % 2), std::ios::cur);
  }
  return {};
}

struct Run { std::vector<double> encoderStartsMs; Clock::time_point start; };
static std::string lastFallback;

int main(int argc, char** argv) {
  if (argc < 4) return 2;
  whisper_log_set([](ggml_log_level, const char* text, void*) {
    if (text && std::strstr(text, "fallbacks")) lastFallback = text;
  }, nullptr);
  auto contextParams = whisper_context_default_params();
  contextParams.use_gpu = true; contextParams.flash_attn = true;
  const auto loadStart = Clock::now();
  whisper_context* context = whisper_init_from_file_with_params(argv[1], contextParams);
  if (!context) return 3;
  std::cout << json{{"event", "loaded"}, {"ms", since(loadStart)}}.dump() << std::endl;
  const int repeats = std::stoi(argv[2]);
  int first = 3; int gapMs = 0;
  std::vector<std::string> qosCycle{"inherit"};
  while (first < argc && !std::strncmp(argv[first], "--", 2)) {
    const std::string option(argv[first]);
    if (option == "--gap-ms") gapMs = std::stoi(argv[first + 1]);
    else if (option == "--qos") {
      qosCycle.clear(); std::stringstream list(argv[first + 1]); std::string item;
      while (std::getline(list, item, ',')) qosCycle.push_back(item);
    } else return 2;
    first += 2;
  }
  size_t runIndex = 0;
  for (int round = 0; round < repeats; ++round) {
    for (int index = first; index < argc; ++index) {
      if (gapMs) std::this_thread::sleep_for(std::chrono::milliseconds(gapMs));
      const auto qos = qosCycle[runIndex++ % qosCycle.size()];
      if (qos == "default") pthread_set_qos_class_self_np(QOS_CLASS_DEFAULT, 0);
      else if (qos == "user-initiated") pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED, 0);
      else if (qos == "user-interactive") pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
      auto audio = readWav(argv[index]);
      const double audioMs = audio.size() / 16.0;
      Run run;
      auto params = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH);
      params.language = "he"; params.detect_language = false; params.translate = false;
      params.print_progress = false; params.print_realtime = false; params.print_timestamps = false;
      params.no_timestamps = false; params.beam_search.beam_size = 1; params.n_threads = 2;
      params.encoder_begin_callback = [](whisper_context*, whisper_state*, void* data) {
        auto* value = static_cast<Run*>(data); value->encoderStartsMs.push_back(since(value->start)); return true;
      };
      params.encoder_begin_callback_user_data = &run;
      whisper_reset_timings(context);
      run.start = Clock::now();
      const int status = whisper_full(context, params, audio.data(), static_cast<int>(audio.size()));
      const double wallMs = since(run.start);
      const auto* timings = whisper_get_timings(context);
      whisper_print_timings(context);
      json segments = json::array();
      size_t textBytes = 0;
      for (int i = 0; i < whisper_full_n_segments(context); ++i) {
        const char* value = whisper_full_get_segment_text(context, i);
        textBytes += value ? std::strlen(value) : 0;
        segments.push_back({whisper_full_get_segment_t0(context, i) * 10, whisper_full_get_segment_t1(context, i) * 10});
      }
      std::string name(argv[index]); name = name.substr(name.find_last_of('/') + 1);
      json out = {{"clip", name}, {"round", round}, {"qos", qos}, {"gapMs", gapMs}, {"atMs", std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count()}, {"status", status}, {"audioMs", audioMs}, {"wallMs", wallMs},
        {"encoderPasses", run.encoderStartsMs.size()}, {"encoderStartsMs", run.encoderStartsMs}, {"segmentsMs", segments}, {"textBytes", textBytes}};
      if (timings) out["perUnit"] = {{"sampleMs", timings->sample_ms}, {"encodeMs", timings->encode_ms}, {"decodeMs", timings->decode_ms}, {"batchdMs", timings->batchd_ms}, {"promptMs", timings->prompt_ms}};
      out["fallbacks"] = lastFallback;
      std::cout << out.dump() << std::endl;
    }
  }
  whisper_free(context);
  return 0;
}
