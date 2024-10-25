import React, { useState, useEffect, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getStorage, ref, getDownloadURL } from "firebase/storage";
import axios from "axios";
import "./App.css";

const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

const app = initializeApp(firebaseConfig);
const storage = getStorage(app);

const QUESTION_WORDS = [
  "what",
  "when",
  "where",
  "who",
  "why",
  "how",
  "which",
  "can",
  "could",
  "would",
  "should",
  "is",
  "are",
  "do",
  "does",
  "did",
  "will",
];

const STOP_WORDS = ["the", "a", "an", "and", "or", "but", "in", "on", "at"];

const useSpeechRecognition = (onTranscriptUpdate) => {
  const recognitionRef = useRef(null);

  useEffect(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = true;
      recognitionRef.current.interimResults = true;
      recognitionRef.current.onresult = (event) => {
        const lastResult = event.results[event.results.length - 1];
        const transcriptText = lastResult[0].transcript;
        onTranscriptUpdate(transcriptText);
      };
    }

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, [onTranscriptUpdate]);

  return recognitionRef;
};

const AudioAssistant = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [questions, setQuestions] = useState([]);
  const [suggestedAnswers, setSuggestedAnswers] = useState([]);
  const [knowledgeBase, setKnowledgeBase] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const lastProcessedTextRef = useRef("");

  const handleTranscriptUpdate = (transcriptText) => {
    setTranscript(transcriptText);
    extractAndProcessQuestions(transcriptText);
  };

  const recognitionRef = useSpeechRecognition(handleTranscriptUpdate);

  useEffect(() => {
    const fetchKnowledgeBase = async () => {
      try {
        const docRef = ref(storage, "medical-text.json");
        const firebaseUrl = await getDownloadURL(docRef);
        const urlObj = new URL(firebaseUrl);
        const proxyUrl = `/firebase${urlObj.pathname}${urlObj.search}`;

        const response = await axios.get(proxyUrl);
        if (!response.data) {
          throw new Error("No data received");
        }

        setKnowledgeBase(response.data);
        console.log("Knowledge base loaded successfully");
      } catch (err) {
        console.error("Error fetching knowledge base:", err);
        setError("Failed to load knowledge base. Please try again later.");
      } finally {
        setIsLoading(false);
      }
    };

    fetchKnowledgeBase();
  }, []);

  const findAnswer = (question) => {
    if (!knowledgeBase) return;

    const lowercaseQuestion = question.toLowerCase().trim();

    const questionWord = QUESTION_WORDS.find((word) =>
      lowercaseQuestion.startsWith(word + " ")
    );

    if (!questionWord || !knowledgeBase[questionWord]) {
      return;
    }

    const relevantQuestions = knowledgeBase[questionWord];

    const words = lowercaseQuestion
      .split(" ")
      .filter((word) => !STOP_WORDS.includes(word));

    let bestMatch = null;
    let maxMatchScore = 0;

    Object.entries(relevantQuestions).forEach(([dbQuestion, answer]) => {
      const dbWords = dbQuestion.toLowerCase().split(" ");

      const matchScore = words.reduce((score, word, index) => {
        if (dbWords.includes(word)) {
          return score + 1 + (words.length - index) / words.length;
        }
        return score;
      }, 0);

      if (matchScore > maxMatchScore) {
        maxMatchScore = matchScore;
        bestMatch = answer;
      }
    });

    if (bestMatch && maxMatchScore > 1) {
      setSuggestedAnswers((prev) => [
        ...prev,
        {
          question,
          answer: bestMatch,
          confidence: maxMatchScore,
        },
      ]);
    }
  };

  const extractAndProcessQuestions = (text) => {
    if (!knowledgeBase) return;
    const resetTriggerWords = ["reset", "clear", "start over"];
    if (resetTriggerWords.some((substring) => text.includes(substring))) {
      stopRecording();
      clearChat();
      return;
    }

    const newText = text.slice(lastProcessedTextRef.current.length);
    lastProcessedTextRef.current = text;

    const sentences = text.split(/[.!?]+/).filter(Boolean);

    sentences.forEach((sentence) => {
      const lowercaseSentence = sentence.toLowerCase().trim();

      const isQuestion = QUESTION_WORDS.some((word) =>
        lowercaseSentence.startsWith(word + " ")
      );

      if (isQuestion) {
        const questionText = sentence.trim();
        if (!questions.includes(questionText)) {
          setQuestions((prev) => [...prev, questionText]);
          findAnswer(questionText);
        }
      }
    });
  };

  const startRecording = () => {
    if (recognitionRef.current) {
      recognitionRef.current.start();
      setIsRecording(true);
      setQuestions([]);
      setSuggestedAnswers([]);
      lastProcessedTextRef.current = "";
      setTranscript("");
    }
  };

  const stopRecording = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      setIsRecording(false);
    }
  };

  const clearChat = () => {
    setQuestions([]);
    setSuggestedAnswers([]);
    lastProcessedTextRef.current = "";
    setTranscript("");
  };

  if (isLoading) {
    return <div>Loading knowledge base...</div>;
  }

  return (
    <div className="assistant-container">
      <h1>Audio Assistant</h1>

      {error && <div style={{ color: "red", margin: "10px 0" }}>{error}</div>}

      <div>
        <button
          onClick={isRecording ? stopRecording : startRecording}
          disabled={!knowledgeBase}
        >
          {isRecording ? "Stop Recording" : "Start Recording"}
        </button>
        <button onClick={clearChat} disabled={!knowledgeBase}>
          Clear Chat
        </button>
      </div>

      <div>
        <h2>Current Question:</h2>
        <p>{transcript}</p>
      </div>

      <div>
        <h2>Current Answer:</h2>
        {questions.map((question, index) => (
          <div key={index}>
            {suggestedAnswers[index] && (
              <p>
                <strong>A: </strong>
                {suggestedAnswers[index].answer}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default AudioAssistant;
