// Hand-written C++ baseline: the todos API on Drogon (a top TechEmpower framework) with its
// fast per-thread Postgres client. Written the way a typical C++ service would be: sensible
// validation, but no attempt to reproduce Effect's exact HTTP semantics. The contract suite
// shows what that costs.
#include <drogon/drogon.h>
#include <cstdlib>
#include <regex>
#include <thread>

using namespace drogon;
using Callback = std::function<void(const HttpResponsePtr&)>;

static HttpResponsePtr json(HttpStatusCode code, const Json::Value& v) {
  auto resp = HttpResponse::newHttpJsonResponse(v);
  resp->setStatusCode(code);
  return resp;
}

static HttpResponsePtr empty(HttpStatusCode code) {
  auto resp = HttpResponse::newHttpResponse();
  resp->setStatusCode(code);
  return resp;
}

static Json::Value todo(const orm::Row& row) {
  Json::Value v;
  v["id"] = row["id"].as<int>();
  v["title"] = row["title"].as<std::string>();
  v["done"] = row["done"].as<bool>();
  return v;
}

int main() {
  const char* url = std::getenv("DATABASE_URL");
  if (!url) {
    LOG_ERROR << "DATABASE_URL is not set";
    return 1;
  }
  // postgres://user[:password]@host[:port]/db
  std::cmatch m;
  if (!std::regex_match(url, m, std::regex(R"(postgres(?:ql)?://([^:@/]+)(?::([^@/]*))?@([^:/]+)(?::(\d+))?/([^?]+).*)"))) {
    LOG_ERROR << "unsupported DATABASE_URL";
    return 1;
  }
  const auto threads = std::max(1u, std::thread::hardware_concurrency());
  const auto perThread = std::max(1u, 10 / threads);  // 10 connections in total, like the other servers

  app()
      .setLogLevel(trantor::Logger::kWarn)
      .addListener("0.0.0.0", 3000)
      .setThreadNum(threads)
      .createDbClient("postgresql", m[3].str(), m[4].matched ? std::stoi(m[4].str()) : 5432, m[5].str(), m[1].str(),
                      m[2].str(), perThread, "", "default", /*isFast=*/true);

  app().registerHandler(
      "/todos/{id}",
      [](const HttpRequestPtr&, Callback&& cb, int64_t id) {
        auto db = app().getFastDbClient();
        db->execSqlAsync(
            "SELECT id, title, done FROM todos WHERE id = $1::int8",  // drogon binds int64 as binary int8
            [cb, id](const orm::Result& r) {
              if (r.empty()) {
                Json::Value e;
                e["_tag"] = "TodoNotFound";
                e["id"] = Json::Int64(id);
                cb(json(k404NotFound, e));
              } else {
                cb(json(k200OK, todo(r[0])));
              }
            },
            [cb](const orm::DrogonDbException&) { cb(empty(k500InternalServerError)); }, id);
      },
      {Get});

  app().registerHandler(
      "/todos",
      [](const HttpRequestPtr& req, Callback&& cb) {
        auto body = req->getJsonObject();
        if (!body || !body->isObject() || !(*body)["title"].isString() || (*body)["title"].asString().empty()) {
          cb(empty(k400BadRequest));
          return;
        }
        auto db = app().getFastDbClient();
        db->execSqlAsync(
            "INSERT INTO todos (title, done) VALUES ($1, false) RETURNING id, title, done",
            [cb](const orm::Result& r) { cb(json(k201Created, todo(r[0]))); },
            [cb](const orm::DrogonDbException&) { cb(empty(k500InternalServerError)); }, (*body)["title"].asString());
      },
      {Post});

  app().run();
}
