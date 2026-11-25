require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "SealedCallNative"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.license      = package["license"]
  s.authors      = { "Booth" => "support@example.com" }
  s.homepage     = "https://github.com/your-org/booth"
  s.platforms    = { :ios => "15.4" }
  s.source       = { :git => "https://github.com/your-org/booth.git", :tag => s.version.to_s }
  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.swift_version = "5.0"

  s.dependency "React-Core"
end
