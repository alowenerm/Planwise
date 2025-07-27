// Firebase Configuration
const firebaseConfig = {
    apiKey: "AIzaSyDfaBbnuKb8Y0Tr9Hai7jQPcalT4IzH8Bg",
    authDomain: "prueba-fae95.firebaseapp.com",
    databaseURL: "https://prueba-fae95-default-rtdb.firebaseio.com",
    projectId: "prueba-fae95",
    storageBucket: "prueba-fae95.firebasestorage.app",
    messagingSenderId: "506974470269",
    appId: "1:506974470269:web:052eebdc07fb542c467114",
    measurementId: "G-SRQWV810V7"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Create global instances for other scripts to use
const db = firebase.database();
const auth = firebase.auth();
