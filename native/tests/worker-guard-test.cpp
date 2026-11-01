// Tests the shipped guard, not a second implementation of UTF-8 validation.
#define main worker_program_main
#include "../whisper-worker.cpp"
#undef main

namespace {
json resultWith(const std::string& text) {
  return {{"text", text}, {"language", "he"}, {"segments", json::array({{{"start", 0}, {"end", 1}, {"text", text}}})}};
}
bool rejected(const std::string& text) {
  try { assertSerializable(resultWith(text)); return false; } catch (const InvalidOutput&) { return true; }
}
int failures = 0;
void expect(bool ok, const char* name) {
  if (!ok) { std::cerr << "FAIL: " << name << std::endl; failures += 1; }
}
}

int main() {
  const std::string valid = "שלום GitHub API 👋";
  const auto good = resultWith(valid);
  const auto before = good.dump();
  expect(!rejected(valid), "valid Hebrew, English and emoji pass");
  assertSerializable(good);
  expect(good.dump() == before, "valid result is unchanged");
  expect(rejected(std::string("prefix ") + char(0xdb) + "H"), "reported DB 48 sequence is rejected");
  expect(rejected(std::string("tail ") + char(0xd7)), "truncated Hebrew letter is rejected");
  std::string carry;
  expect(repairUtf8(valid, carry) == valid && carry.empty(), "repair keeps valid text");
  expect(repairUtf8(std::string("prefix ") + char(0xdb) + "H", carry) == "prefix H", "repair drops a broken sequence");
  const std::string letter = "ש";
  expect(repairUtf8("אב" + letter.substr(0, 1), carry) == "אב" && carry == letter.substr(0, 1), "repair holds a split letter");
  expect(repairUtf8(letter.substr(1) + "ת", carry) == "שת" && carry.empty(), "repair joins a split letter");
  expect(repairUtf8(std::string(1, char(0xc0)) + char(0x80) + char(0xed) + char(0xa0) + char(0x80) + "ok", carry) == "ok", "repair drops overlong and surrogate bytes");
  assertSerializable(resultWith(repairUtf8(std::string("tail ") + char(0xd7), carry)));
  if (failures == 0) std::cout << "PASS: worker guard" << std::endl;
  return failures == 0 ? 0 : 1;
}
