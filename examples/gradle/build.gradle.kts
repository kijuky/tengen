plugins {
    java
}

repositories {
    maven {
        url = uri("http://localhost:3000/maven")
        isAllowInsecureProtocol = true
    }
}

dependencies {
    implementation("org.apache.commons:commons-lang3:+")
}
