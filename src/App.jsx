import React, { useState, useEffect, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getStorage, ref, getDownloadURL } from "firebase/storage";
import axios from "axios";
import OpenAI from "openai";
import "./App.css";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_APP_ID,
};

const app = initializeApp(firebaseConfig);
const storage = getStorage(app);
const openai = new OpenAI({
  apiKey: import.meta.env.VITE_OPENAI_API_KEY,
  dangerouslyAllowBrowser: true,
});

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
  const [, setKnowledgeBase] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const lastProcessedTextRef = useRef("");
  const loadedQuestionWords = useRef(new Set());
  const pendingQuestions = useRef([]);
  const [isAiLoading, setIsAiLoading] = useState(false);

  const handleTranscriptUpdate = (transcriptText) => {
    setTranscript(transcriptText);
  };

  const recognitionRef = useSpeechRecognition(handleTranscriptUpdate);

  const fetchAnswerFromOpenAI = async (question) => {
    setIsAiLoading(true);
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant providing clear, concise answers to medical questions.",
          },
          {
            role: "user",
            content: question,
          },
        ],
        temperature: 0.7,
        max_tokens: 2048,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
        response_format: {
          type: "text",
        },
      });

      if (response.choices.length > 0) {
        return response.choices[0].message.content;
      } else {
        console.error("OpenAI API response error:", response);
        setError("Failed to get an AI answer. Please try again.");
        return null;
      }
    } catch (err) {
      console.error("Error fetching answer from OpenAI:", err);
      setError("Failed to get an AI answer. Please try again.");
      return null;
    } finally {
      setIsAiLoading(false);
    }
  };

  const fetchKnowledgeBaseForWord = async (questionWord) => {
    if (loadedQuestionWords.current.has(questionWord)) {
      return;
    }

    setIsLoading(true);
    try {
      const docRef = ref(storage, `${questionWord}-medical-questions.json`);
      const firebaseUrl = await getDownloadURL(docRef);
      const urlObj = new URL(firebaseUrl);
      const proxyUrl = `/firebase${urlObj.pathname}${urlObj.search}`;
      const response = await axios.get(proxyUrl);

      if (!response.data) {
        throw new Error(`No data received for ${questionWord}`);
      }

      setKnowledgeBase((prevBase) => {
        const newBase = {
          ...prevBase,
          [questionWord]: response.data[questionWord],
        };
        return newBase;
      });

      return response.data;
    } catch (err) {
      console.error(`Error fetching knowledge base for ${questionWord}:`, err);
      setError(
        `Failed to load knowledge base for "${questionWord}" questions. Please try again later.`
      );
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  const findAnswer = async (question) => {
    const lowercaseQuestion = question.toLowerCase().trim();
    const questionWord = QUESTION_WORDS.find((word) =>
      lowercaseQuestion.startsWith(word + " ")
    );

    if (!questionWord) {
      return;
    }

    const fetchKnowledge = await fetchKnowledgeBaseForWord(questionWord);

    const relevantQuestions = fetchKnowledge[questionWord];

    const words = lowercaseQuestion
      .split(" ")
      .filter((word) => !STOP_WORDS.includes(word));

    let bestMatch = null;
    let maxMatchScore = 0;

    Object.entries(relevantQuestions).forEach(([dbQuestion, answer]) => {
      console.log(dbQuestion);
      const dbWords = answer.toLowerCase().split(" ");

      const matchScore = words.reduce((score, word, index) => {
        if (dbWords.includes(word)) {
          return score + 1 + (words.length - index) / words.length;
        }
        return score;
      }, 0);

      if (matchScore > maxMatchScore) {
        maxMatchScore = matchScore;
        bestMatch = dbQuestion;
      }
    });

    if (bestMatch && maxMatchScore > 1) {
      try {
        const aiAnswer = await fetchAnswerFromOpenAI(question);

        setSuggestedAnswers((prev) => [
          ...prev,
          {
            question,
            answer: aiAnswer,
            confidence: maxMatchScore,
          },
        ]);
      } catch (error) {
        console.error("Error fetching AI answer:", error);
      }
    } else {
      console.log("No suitable match found");
    }
  };

  const extractAndProcessQuestions = (text) => {
    const resetTriggerWords = ["reset", "clear", "start over"];
    if (resetTriggerWords.some((substring) => text.includes(substring))) {
      stopRecording();
      clearChat();
      return;
    }

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
      pendingQuestions.current = [];
      setError(null);
    }
  };

  const stopRecording = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      setIsRecording(false);
      extractAndProcessQuestions(transcript);
    }
  };

  const clearChat = () => {
    setQuestions([]);
    setSuggestedAnswers([]);
    lastProcessedTextRef.current = "";
    setTranscript("");
    pendingQuestions.current = [];
    setError(null);
  };

  return (
    <div className="assistant-container">
      <h1>Audio Assistant</h1>

      {error && <div style={{ color: "red", margin: "10px 0" }}>{error}</div>}

      <div>
        <button
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isLoading}
        >
          {isRecording ? "Stop Recording" : "Start Recording"}
        </button>
        <button onClick={clearChat} disabled={isLoading}>
          Clear Chat
        </button>
      </div>

      <div>
        <h2>Current Question:</h2>
        <p>{transcript}</p>
      </div>

      <div>
        <h2>Current Answer:</h2>
        {isAiLoading ? (
          <div>Fetching Answer</div>
        ) : (
          suggestedAnswers.map((answer, index) => (
            <div key={index}>
              <p>
                <strong>Q: </strong>
                {answer.question}
              </p>
              <p>
                <strong>A: </strong>
                {answer.answer}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default AudioAssistant;
