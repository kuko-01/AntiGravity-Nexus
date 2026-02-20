import React from 'react';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import HomeScreen from './screens/HomeScreen';
import CaptureScreen from './screens/CaptureScreen';
import OrganizerScreen from './screens/OrganizerScreen';
import NanoStudioScreen from './screens/NanoStudioScreen';
import VoiceStudioScreen from './screens/VoiceStudioScreen';
import TrainerScreen from './screens/TrainerScreen';
import Live2DControllerScreen from './screens/Live2DControllerScreen';
import CharacterStudioScreen from './screens/CharacterStudioScreen';

const App: React.FC = () => {
    return (
        <Router>
            <Routes>
                <Route path="/" element={<HomeScreen />} />
                <Route path="/capture" element={<CaptureScreen />} />
                <Route path="/organizer" element={<OrganizerScreen />} />
                <Route path="/nano" element={<NanoStudioScreen />} />
                <Route path="/tts" element={<VoiceStudioScreen />} />
                <Route path="/character" element={<CharacterStudioScreen />} />
                <Route path="/trainer" element={<TrainerScreen />} />
                <Route path="/live2d" element={<Live2DControllerScreen />} />
            </Routes>
        </Router>
    );
};

export default App;
