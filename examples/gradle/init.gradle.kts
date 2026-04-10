// Place this file in ~/.gradle/init.d/ to apply it to all Gradle builds.
allprojects {
    repositories {
        maven {
            url = uri("http://localhost:3000/maven")
            isAllowInsecureProtocol = true
        }
    }
    buildscript {
        repositories {
            maven {
                url = uri("http://localhost:3000/maven")
                isAllowInsecureProtocol = true
            }
        }
    }
}
